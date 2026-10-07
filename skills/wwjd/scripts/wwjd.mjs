#!/usr/bin/env node
// Node 18+, zero dependencies. Import runCli for local, injected-fetch tests.
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { access, chmod, lstat, mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DEFAULT_API_BASE = 'https://findjevsus.com';
export const HTTP_TIMEOUT_MS = 60_000;
const MAX_BYTES = 8 * 1024 * 1024;
const VERDICTS = ['aligned', 'not_aligned', 'discernment_required'];
const REASONS = ['judged', 'dilemma', 'guard_override', 'guard_soft', 'guard_refused', 'great_commandment_concern', 'inconsistent', 'manipulation_suspected', 'low_margin', 'refused'];
const PAUSE = 'Do not perform this action unasked. Ask your human; in a headless run, skip this step and report it blocked.';
const USAGE = "Usage: wwjd.mjs '<action>' [--context <text> | --context-file <path> | --stdin] [--json] [--allow-secrets]\n       wwjd.mjs me | feedback <decision_id> <verdict> '<note>' | buy simple|pro";
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const probability = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1;

class CliError extends Error {
  constructor(message, code = 1, data = undefined) { super(message); this.code = code; this.data = data; }
}
class HttpError extends Error {
  constructor(status, data, retryAfter, path) {
    super('API request failed');
    Object.assign(this, { status, data, retryAfter, path });
    this.hasErrorEnvelope = object(data?.error) && typeof data.error.code === 'string' && data.error.code.trim().length > 0
      && typeof data.error.message === 'string' && data.error.message.trim().length > 0;
  }
}

export function leadingZeroBits(bytes) {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0) count += 8;
    else return count + Math.clz32(byte) - 24;
  }
  return count;
}

export function powDigest(challenge, nonce) {
  return createHash('sha256').update(`${challenge}:${nonce}`, 'utf8').digest();
}

export async function solvePow(challenge, difficulty) {
  if (typeof challenge !== 'string' || !challenge || challenge.length > 8192 || !Number.isInteger(difficulty) || difficulty < 0 || difficulty > 24) {
    throw new CliError('WWJD returned an unusable registration challenge. Ask your human to get a key at https://findjevsus.com/docs.');
  }
  const started = Date.now();
  for (let nonce = 0; ; nonce++) {
    if (leadingZeroBits(powDigest(challenge, String(nonce))) >= difficulty) return String(nonce);
    if (nonce % 8192 === 0) {
      if (Date.now() - started > HTTP_TIMEOUT_MS) throw new CliError('Registration proof of work timed out. Ask your human to get a key at https://findjevsus.com/docs.');
      await new Promise(resolve => setImmediate(resolve));
    }
  }
}

// Bounded prefix patterns plus one character pass: no nested or unbounded backtracking.
export function secretShape(text) {
  if (/-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----/.test(text)) return 'a private key block';
  if (/\bsk-[A-Za-z0-9_-]{16}/.test(text)) return 'an API key';
  if (/\bghp_[A-Za-z0-9]{20}/.test(text)) return 'a GitHub token';
  if (/\bAKIA[A-Z0-9]{16}/.test(text)) return 'an AWS access key';
  if (/\bwwjd_[A-Za-z0-9]{20}/.test(text)) return 'a WWJD key';
  let length = 0, hex = true;
  const suspicious = () => length >= 40 && hex ? 'a long hexadecimal token'
    : length >= 64 ? 'a long base64-shaped token' : null;
  for (let i = 0; i <= text.length; i++) {
    const c = text.charCodeAt(i);
    const alpha = c >= 65 && c <= 90 || c >= 97 && c <= 122;
    const digit = c >= 48 && c <= 57;
    const symbol = c === 43 || c === 47 || c === 61 || c === 95 || c === 45;
    if (alpha || digit || symbol) {
      length++;
      hex &&= digit || c >= 65 && c <= 70 || c >= 97 && c <= 102;
    } else {
      const found = suspicious();
      if (found) return found;
      length = 0; hex = true;
    }
  }
  return null;
}

function parseArgs(args) {
  const options = { positional: [] };
  let literal = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (!literal && arg === '--') { literal = true; continue; }
    if (!literal && arg.startsWith('--')) {
      if (['--json', '--allow-secrets', '--stdin', '--help'].includes(arg)) {
        if (options[arg]) throw new CliError(`Duplicate option ${arg}.`);
        options[arg] = true;
      } else if (['--context', '--context-file'].includes(arg)) {
        if (options[arg] !== undefined || args[i + 1] === undefined) throw new CliError(`Supply ${arg} exactly once with its value.`);
        options[arg] = args[++i];
      } else throw new CliError(`Unknown option.\n${USAGE}`);
    } else options.positional.push(arg);
  }
  if (['--context', '--context-file', '--stdin'].filter(key => options[key] !== undefined).length > 1) {
    throw new CliError('Use only one context source: --context, --context-file or --stdin.');
  }
  if (options['--context'] !== undefined && Buffer.byteLength(options['--context'], 'utf8') > 64 * 1024) {
    throw new CliError('--context exceeds 64 KiB. Save it to a file and use --context-file <path>.');
  }
  return options;
}

async function readBounded(stream) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BYTES) throw new CliError('Input exceeds the 8 MB body limit. Shorten the action or context.');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function getInput(options, cwd, stdin) {
  const [command, ...rest] = options.positional;
  const hasContext = ['--context', '--context-file', '--stdin'].some(key => options[key] !== undefined);
  if (['me', 'feedback', 'buy'].includes(command)) {
    if (hasContext) throw new CliError('Context options apply only to alignment decisions.');
    if (command === 'me' && rest.length === 0) return { command, path: '/v1/me', method: 'GET' };
    if (command === 'buy' && rest.length === 1 && ['simple', 'pro'].includes(rest[0])) return { command, path: '/v1/checkout', method: 'POST', body: { plan: rest[0] } };
    if (command === 'feedback' && rest.length === 3 && /^dec_[a-z0-9-]+$/.test(rest[0]) && VERDICTS.includes(rest[1]) && rest[2].length <= 2000) {
      return { command, path: '/v1/feedback', method: 'POST', body: { decision_id: rest[0], expected_verdict: rest[1], note: rest[2] }, sensitive: [rest[2]] };
    }
    throw new CliError(USAGE);
  }
  if (rest.length) throw new CliError('Quote the action as one argument.\n' + USAGE);
  let action = command, context = options['--context'];
  if (options['--context-file'] !== undefined) {
    let file;
    try {
      file = await open(resolve(cwd, options['--context-file']), 'r');
      if (!(await file.stat()).isFile()) throw new CliError('--context-file must name a regular file.');
      context = await readBounded(file.createReadStream({ autoClose: false }));
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError('Could not read --context-file. Check its path and permissions.');
    } finally { await file?.close(); }
  }
  if (options['--stdin']) {
    const raw = await readBounded(stdin);
    if (raw.trimStart().startsWith('{')) {
      let data;
      try { data = JSON.parse(raw); } catch { throw new CliError('--stdin starts with { but is not valid JSON. Use {"action":"…","context":"…"} or raw context.'); }
      if (!object(data) || Object.keys(data).some(key => !['action', 'context'].includes(key)) || typeof data.action !== 'string' || data.context !== undefined && typeof data.context !== 'string') {
        throw new CliError('--stdin JSON must be {action: string, context?: string}.');
      }
      if (action !== undefined && action !== data.action) throw new CliError('The argument and --stdin JSON contain different actions. Supply only one action.');
      action = data.action; context = data.context;
    } else context = raw;
  }
  if (typeof action !== 'string' || !action.trim()) throw new CliError('Provide a non-empty action.\n' + USAGE);
  action = action.trim();
  const body = { action, ...(context !== undefined ? { context } : {}) };
  const tokens = Math.ceil((action.length + (context?.length || 0)) / 4);
  if (tokens > 1_000_000 || Buffer.byteLength(JSON.stringify(body)) > MAX_BYTES) throw new CliError('Input exceeds 1,000,000 estimated tokens or the 8 MB body limit. Shorten it; nothing was sent.');
  return { command: 'decide', method: 'POST', path: '/v1/wwjd', body, tokens, credits: tokens <= 100_000 ? 1 : 5, sensitive: [action, context || ''] };
}

function apiSettings(env) {
  let url;
  try { url = new URL(env.WWJD_API_BASE || DEFAULT_API_BASE); } catch { throw new CliError('WWJD_API_BASE must be an http(s) URL.'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new CliError('WWJD_API_BASE must be an http(s) URL without credentials, query or fragment.');
  const base = url.href.replace(/\/+$/, '');
  return { base, selfhost: base !== DEFAULT_API_BASE };
}

async function request(fetcher, base, path, method, body, key) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  try {
    let response, raw;
    try {
      response = await fetcher(base + path, {
        method, redirect: 'manual', signal: controller.signal,
        headers: { Accept: 'application/json', 'Content-Type': 'application/json', ...(key ? { Authorization: `Bearer ${key}` } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      if (response.body) raw = await readBounded(response.body);
      else raw = await response.text();
    } catch (error) {
      // A received error status survives an unreadable or oversized edge response.
      if (response && !response.ok) throw new HttpError(response.status, undefined, response.headers.get('retry-after'), path);
      if (error instanceof CliError) throw new CliError('WWJD returned an oversized response. ' + PAUSE);
      throw new CliError("Could not reach findjevsus.com. Your agent's sandbox may block network access; ask your human to allow network for this command. " + PAUSE, 22);
    }
    let data;
    try { data = JSON.parse(raw); }
    catch {
      if (!response.ok) throw new HttpError(response.status, undefined, response.headers.get('retry-after'), path);
      throw new CliError(`WWJD returned invalid JSON (HTTP ${response.status}). ${PAUSE}`);
    }
    if (!response.ok) throw new HttpError(response.status, data, response.headers.get('retry-after'), path);
    if (!object(data)) throw new CliError('WWJD returned an invalid response. ' + PAUSE);
    return data;
  } finally { clearTimeout(timeout); }
}

function usableKey(key, hosted = true) {
  return typeof key === 'string' && (hosted ? /^wwjd_[A-Za-z0-9]{43}$/.test(key) : key.length > 0 && key.length <= 8192 && /^[\x21-\x7E]+$/.test(key));
}

async function readKey(path) {
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === 'ENOENT' || error.code === 'ENOTDIR') return undefined; throw new CliError('Cannot inspect the existing WWJD key file. No new key was created.'); }
  if (!info.isFile()) throw new CliError('The WWJD key path is not a regular file. Ask your human to inspect it; no new key was created.');
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const info = await handle.stat();
    if (info.size > 8192) throw new CliError('The existing WWJD key file is invalid. Ask your human to inspect it; no new key was created.');
    const key = (await handle.readFile('utf8')).trim();
    if (!usableKey(key)) throw new CliError('The existing WWJD key file is empty or invalid. Ask your human to inspect it; no new key was created.');
    if ((info.mode & 0o777) !== 0o600) await handle.chmod(0o600);
    return key;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError('Cannot read or secure the existing WWJD key file. No new key was created.');
  } finally { await handle?.close(); }
}

async function secureDirectory(path) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  if (!(await lstat(path)).isDirectory()) throw new CliError('The WWJD config directory must be a real directory, not a symlink.');
  await chmod(path, 0o700);
  await access(path, constants.W_OK);
}

// Caller holds key.lock, so no first-run peer can observe the file mid-write.
async function ensureLocalIgnore(path) {
  let handle;
  try { handle = await open(join(path, '.gitignore'), 'wx', 0o600); await handle.writeFile('*\n'); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  finally { await handle?.close(); }
  const ignore = await readFile(join(path, '.gitignore'), 'utf8');
  if (!ignore.split(/\r?\n/).includes('*')) throw new CliError('The project-local .wwjd/.gitignore must contain * before saving a key.');
}

async function getKey(env, cwd, settings, call, progress) {
  if (Object.hasOwn(env, 'WWJD_API_KEY')) {
    const key = env.WWJD_API_KEY?.trim();
    if (!usableKey(key, !settings.selfhost)) throw new CliError('WWJD_API_KEY is empty or invalid. Ask your human to set it; no new key was created.');
    return key;
  }
  if (settings.selfhost) throw new CliError('Self-hosting needs WWJD_API_KEY matching the server OWNER_KEY. No key is auto-registered for WWJD_API_BASE. ' + PAUSE);
  const homeDirectory = resolve(cwd, env.HOME || homedir(), '.config', 'wwjd');
  const localDirectory = resolve(cwd, '.wwjd');
  const directories = [...new Set([env.WWJD_CONFIG_DIR && resolve(cwd, env.WWJD_CONFIG_DIR), homeDirectory, localDirectory].filter(Boolean))];
  const lookup = async () => {
    for (const dir of directories) {
      const key = await readKey(join(dir, 'key'));
      if (key !== undefined) return key;
    }
  };
  const existing = await lookup();
  if (existing) return existing;
  let storage;
  for (const dir of directories) {
    try { await secureDirectory(dir); storage = dir; break; }
    catch (error) {
      if (error instanceof CliError) throw error;
      if (!['EACCES', 'EPERM', 'EROFS', 'ENOTDIR'].includes(error.code)) throw new CliError('Cannot create a private WWJD config directory. No key was created.');
    }
  }
  if (!storage) throw new CliError('Neither the home nor project WWJD config directory is writable. Ask your human to supply WWJD_API_KEY.');
  const lockPath = join(storage, 'key.lock'), keyPath = join(storage, 'key');
  const started = Date.now();
  let lock;
  while (!lock) {
    const key = await lookup();
    if (key) return key;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw new CliError('Cannot reserve the WWJD key file. No key was created.');
      let state;
      try { state = JSON.parse(await readFile(lockPath, 'utf8')); } catch {}
      if (state?.state === 'needs_recovery') throw new CliError(`A previous WWJD registration has an unknown outcome. Ask your human to inspect ${lockPath}; no second key was created.`);
      if (Date.now() - started > 150_000) throw new CliError(`WWJD registration is already in progress or needs recovery. Ask your human to inspect ${lockPath}; no second key was created.`);
      await sleep(50);
    }
  }
  let releaseLock = true, temporary;
  try {
    await lock.writeFile(JSON.stringify({ pid: process.pid, started_at: new Date().toISOString() }) + '\n');
    const existing = await lookup();
    if (existing) return existing;
    if (storage === localDirectory) await ensureLocalIgnore(storage);
    progress('Creating your free WWJD key: requesting a challenge and solving proof of work…');
    const challenge = await call('/v1/keys/challenge', 'GET');
    const nonce = await solvePow(challenge.challenge, challenge.difficulty);
    releaseLock = false; // An ambiguous POST must not silently spend another registration.
    let registered;
    try { registered = await call('/v1/keys', 'POST', { challenge: challenge.challenge, nonce }); }
    catch (error) {
      if (error instanceof HttpError && (error.status < 500 || error.hasErrorEnvelope)) releaseLock = true;
      throw error;
    }
    if (!usableKey(registered.key)) throw new CliError(`Registration returned an invalid key. Ask your human to inspect ${lockPath}; no second key will be created.`);
    temporary = join(storage, `key.tmp.${randomBytes(12).toString('hex')}`);
    const handle = await open(temporary, 'wx', 0o600);
    try { await handle.writeFile(registered.key + '\n'); await handle.sync(); } finally { await handle.close(); }
    if (await readKey(keyPath)) throw new CliError('A WWJD key appeared during registration. Both files were preserved; ask your human to inspect the config directory.');
    await rename(temporary, keyPath);
    temporary = undefined; releaseLock = true;
    progress(`Created WWJD key ${registered.key.slice(0, 10)}…; saved privately at ${keyPath}.`);
    return registered.key;
  } finally {
    if (!releaseLock) {
      progress(`Registration outcome is uncertain. Ask your human to inspect the recovery lock at ${lockPath}; no second key will be created.`);
      const state = Buffer.from(JSON.stringify({ pid: process.pid, state: 'needs_recovery', at: new Date().toISOString() }) + '\n');
      await lock.write(state, 0, state.length, 0);
      await lock.truncate(state.length);
    }
    await lock.close();
    if (releaseLock) await unlink(lockPath).catch(() => {});
    // On an uncertain save, retain the private temporary file and lock for human recovery.
  }
}

export function validateDecision(data, selfhost = false) {
  const valid = object(data) && /^dec_[a-z0-9-]+$/.test(data.id) && data.object === 'wwjd.decision'
    && VERDICTS.includes(data.verdict) && REASONS.includes(data.reason) && typeof data.ask_human === 'boolean' && typeof data.refused === 'boolean'
    && (data.refused ? data.alignment_probability === null && data.confidence === null && data.ask_human : probability(data.alignment_probability) && probability(data.confidence))
    && (data.verdict === 'aligned' || data.ask_human === true)
    && object(data.verdict_probabilities) && VERDICTS.every(key => probability(data.verdict_probabilities[key]) || data.refused && data.verdict_probabilities[key] === null)
    && object(data.scores) && ['love_of_god', 'love_of_neighbor'].every(key => probability(data.scores[key]) || data.scores[key] === null)
    && object(data.guards) && Array.isArray(data.guards.ten_commandments) && Array.isArray(data.guards.triggered)
    && data.guards.ten_commandments.every(item => object(item) && typeof item.id === 'string' && typeof item.commandment === 'string' && typeof item.ref === 'string' && probability(item.probability))
    && object(data.basis) && typeof data.basis.truncated === 'boolean' && Array.isArray(data.basis.passages)
    && typeof data.summary === 'string' && typeof data.disclaimer === 'string'
    && (selfhost && data.credits === undefined || object(data.credits) && Number.isInteger(data.credits.charged) && data.credits.charged >= 0 && Number.isInteger(data.credits.remaining) && typeof data.credits.plan === 'string')
    && (selfhost && data.retention === undefined || typeof data.retention === 'string');
  if (!valid) throw new CliError('WWJD returned a malformed or contradictory decision. No usable verdict. ' + PAUSE);
  const inconsistentProbabilities = !data.refused && (Math.abs(data.confidence - data.verdict_probabilities[data.verdict]) > 0.001
    || Math.abs(VERDICTS.reduce((sum, key) => sum + data.verdict_probabilities[key], 0) - 1) > 0.01);
  const inconsistentApproval = data.verdict === 'aligned' && !data.refused && (data.reason !== 'judged' || data.alignment_probability < 0.7 || data.verdict_probabilities.aligned < 0.6
    || !probability(data.guards.manipulation) || data.guards.manipulation >= 0.7 || data.scores.love_of_neighbor === null
    || data.guards.ten_commandments.some(item => item.probability >= 0.5) || data.guards.triggered.length > 0
    || !Array.isArray(data.guards.notes) || data.guards.notes.some(note => typeof note !== 'string' || note.startsWith('guard_refused:')));
  if (inconsistentProbabilities || inconsistentApproval) {
    throw new CliError('WWJD returned a contradictory decision. No usable verdict. ' + PAUSE);
  }
  return data;
}

function decisionResult(data) {
  if (data.refused) return { code: 1, summary: 'WWJD could not judge this action. ' + PAUSE };
  const label = `WWJD: ${data.verdict} (${Math.round(data.alignment_probability * 100)}%).`;
  if (data.ask_human) return { code: data.verdict === 'aligned' ? 12 : data.verdict === 'not_aligned' ? 10 : 11, summary: label + ' Stop and ask your human before proceeding.' };
  return { code: 0, summary: label + ' WWJD has no objection; proceed only within what your human authorized.' };
}

function errorResult(error, selfhost) {
  if (error instanceof HttpError) {
    const { status, data, retryAfter, path } = error;
    if (status === 402) return { code: 20, summary: 'WWJD credits are insufficient. Show your human the options below verbatim. Do not create another key, purchase or self-host to bypass this. ' + PAUSE, data };
    if (status === 409 && path === '/v1/checkout' && data?.error?.code === 'already_subscribed') {
      const url = data.error.portal_url || data.portal_url;
      return { code: 1, summary: `Already subscribed. Manage your subscription: ${safeLink(url)}.`, data };
    }
    if (status === 503 && ['/v1/checkout', '/v1/billing/portal'].includes(path) && error.hasErrorEnvelope && data.error.options?.open_source) {
      let url;
      try { url = safeLink(data.error.options.open_source.url); } catch {}
      if (url) return { code: 21, summary: `Paid plans are not open yet. ${data.error.message} Open source: ${url}`, data };
    }
    if ([429, 503, 504].includes(status)) {
      let summary = `WWJD is temporarily unavailable (HTTP ${status}). Retry-After: ${retryAfter || 'not supplied'}. `;
      if (status === 429 && path === '/v1/keys') summary += 'Ask your human to get a key at https://findjevsus.com/docs and set WWJD_API_KEY. ';
      if (selfhost && data?.error?.code === 'owner_key_required') summary += 'The server owner must configure OWNER_KEY and give you the matching WWJD_API_KEY. ';
      return { code: 21, summary: summary + PAUSE, data };
    }
    const auth = status === 401 ? selfhost ? 'Set WWJD_API_KEY to the server OWNER_KEY. ' : 'Ask your human to check WWJD_API_KEY or the existing key at https://findjevsus.com/docs; do not create a replacement key. ' : '';
    return { code: 1, summary: `WWJD request failed (HTTP ${status}). ${auth}${PAUSE}`, data };
  }
  return { code: error instanceof CliError ? error.code : 1, summary: error instanceof CliError ? error.message : 'WWJD could not complete the request. ' + PAUSE, data: error instanceof CliError ? error.data : undefined };
}

function safeLink(value) {
  try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol) && !url.username && !url.password) return url.href; } catch {}
  throw new CliError('WWJD did not return a valid checkout or portal link. Ask your human to use https://findjevsus.com/docs.');
}

export async function runCli({ args = process.argv.slice(2), env = process.env, cwd = process.cwd(), stdin = process.stdin, stdout = process.stdout, stderr = process.stderr, fetch: fetcher = globalThis.fetch } = {}) {
  let options = { '--json': args.includes('--json') }, selfhost = false, key;
  const write = (stream, value) => stream.write(String(value).split(key || '\0').join(key ? '[REDACTED KEY]' : '\0') + '\n');
  const output = ({ summary, data, code }) => {
    write(options['--json'] ? stderr : stdout, summary);
    write(stdout, JSON.stringify(data ?? { error: { code: 'client_error', message: summary } }, null, 2));
    return code;
  };
  try {
    options = parseArgs(args);
    if (options['--help']) { write(stdout, USAGE); return 0; }
    const input = await getInput(options, cwd, stdin);
    if (!options['--allow-secrets']) {
      for (const text of input.sensitive || []) {
        const shape = secretShape(text);
        if (shape) throw new CliError(`Possible secret detected (${shape}); nothing was sent. Request text goes to OpenAI and hosted WWJD stores it for 30 days. Describe the action without secrets, or explicitly use --allow-secrets if you intend to send it.`);
      }
    }
    const settings = apiSettings(env); selfhost = settings.selfhost;
    if (input.command === 'decide') write(stderr, `Estimated input: ${input.tokens.toLocaleString('en-US')} tokens; ${input.credits} credit${input.credits === 1 ? '' : 's'}${selfhost ? ' at hosted rates (self-hosting does not bill WWJD credits)' : ''}.`);
    const call = (path, method, body, bearer) => request(fetcher, settings.base, path, method, body, bearer);
    key = await getKey(env, cwd, settings, call, message => write(stderr, message));
    const data = await call(input.path, input.method, input.body, key);
    if (input.command === 'decide') return output({ ...decisionResult(validateDecision(data, selfhost)), data });
    if (input.command === 'buy') return output({ code: 0, summary: 'Ask your human to review and complete checkout: ' + safeLink(data.url), data });
    if (input.command === 'feedback') {
      if (typeof data.id !== 'string' || !/^fb_[a-z0-9-]+$/.test(data.id)) throw new CliError('WWJD returned malformed feedback confirmation.');
      return output({ code: 0, summary: `Feedback received by WWJD (${data.id}).`, data });
    }
    if (typeof data.plan !== 'string' || !Number.isInteger(data.credits_remaining)) throw new CliError('WWJD returned malformed account information.');
    return output({ code: 0, summary: `WWJD plan: ${data.plan}; ${data.credits_remaining} credits remaining.`, data });
  } catch (error) {
    try { return output(errorResult(error, selfhost)); }
    catch (nested) { return output(errorResult(nested, selfhost)); }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await runCli();
