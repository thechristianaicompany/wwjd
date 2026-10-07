import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { gzipSync } from 'node:zlib';
import { build as bundle } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Commandment, Directives, Pack, Teaching, Topic, Verse } from '../src/index.ts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const readJSON = <T>(directory: string, name: string): T => JSON.parse(readFileSync(join(directory, name), 'utf8'));
const escapeHTML = (text: string) => text.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const web = readJSON<Record<string, string>>(join(root, 'sources'), 'web_text.json');
const themes = readJSON<Record<string, { category: string; verse_refs: string[] }>>(join(root, 'sources'), 'bible_topics.json');
const pericopes = readJSON<{ name: string; verse_refs: string[] }[]>(join(root, 'sources'), 'bible_pericopes.json');
const temporary = mkdtempSync(join(tmpdir(), 'wwjd-corpus-tests-'));
const output = join(temporary, 'first');
const secondOutput = join(temporary, 'second');
const fixtureOutput = join(temporary, 'fixture');
const rank = { jesus_teaching: 0, nt: 1, ot: 2 };
const gospels = new Set(['Matthew', 'Mark', 'Luke', 'John']);
const ntBooks = new Set(['Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', '1 Corinthians', '2 Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians', '2 Thessalonians', '1 Timothy', '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James', '1 Peter', '2 Peter', '1 John', '2 John', '3 John', 'Jude', 'Revelation']);
const resolvedSourceRefs = new Map<string, string[]>();

// This oracle reads pinned source keys, independently of the production range resolver.
function sourceRefs(reference: string): string[] {
  const resolved = resolvedSourceRefs.get(reference);
  if (resolved) return resolved;
  const match = /^(.*?) (\d+):(\d+)(?:-(?:(\d+):)?(\d+))?$/.exec(reference);
  if (!match) throw new Error(`Bad test reference: ${reference}`);
  const [, book, startChapter, startVerse, endChapter, endVerse] = match;
  const firstC = Number(startChapter), firstV = Number(startVerse);
  const lastC = Number(endChapter ?? startChapter), lastV = Number(endVerse ?? startVerse);
  const keys = Object.keys(web).filter(ref => ref.startsWith(`${book} `));
  const refs = keys.filter(ref => {
    const [c, v] = ref.slice(String(book).length + 1).split(':').map(Number) as [number, number];
    return (c > firstC || (c === firstC && v >= firstV)) && (c < lastC || (c === lastC && v <= lastV));
  });
  refs.sort((a, b) => {
    const [ac, av] = a.slice(String(book).length + 1).split(':').map(Number) as [number, number];
    const [bc, bv] = b.slice(String(book).length + 1).split(':').map(Number) as [number, number];
    return ac - bc || av - bv;
  });
  expect(refs[0], reference).toBe(`${book} ${firstC}:${firstV}`);
  expect(refs.at(-1), reference).toBe(`${book} ${lastC}:${lastV}`);
  for (const ref of refs) expect(web[ref]?.trim(), ref).toBeTruthy();
  resolvedSourceRefs.set(reference, refs);
  return refs;
}
const sourceText = (reference: string) => sourceRefs(reference).map(ref => web[ref]).join(' ');
const directivePassages = (directives: Directives): Verse[] => [...directives.great_commandments, directives.new_commandment, directives.golden_rule, directives.ten_commandments_passage, ...directives.ten_commandments];
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? files(join(directory, entry.name)).map(name => join(entry.name, name))
    : [entry.name]).sort();
}

interface Manifest {
  corpus_version: string;
  counts: { topics: number; teachings: number; verses: number; commandments: number; source_verses: number };
  source_hashes: Record<string, string>;
  output_hashes: Record<string, string>;
  topic_est_tokens: Record<string, number>;
  runtime_gzip_bytes: number;
  referenced_only: boolean;
}
let directives: Directives;
let taxonomy: Topic[];
let teachings: Teaching[];
let texts: Record<string, string>;
let packs: Record<string, Pack>;
let subset: Record<string, string>;
let manifest: Manifest;
let api: typeof import('../src/index.ts');
let loadSources: (directory?: string) => unknown;
let renderCatalog: (data: unknown) => string;

beforeAll(async () => {
  const builder = await import(pathToFileURL(join(root, 'src/build.mjs')).href);
  const source = await import(pathToFileURL(join(root, 'src/source.mjs')).href);
  const renderer = await import(pathToFileURL(join(root, 'src/catalog.mjs')).href);
  loadSources = source.loadSources;
  renderCatalog = renderer.catalog;
  await builder.buildCorpus({ destination: output });
  await builder.buildCorpus({ destination: secondOutput });
  await builder.buildCorpus({ destination: fixtureOutput, fixture: true });
  directives = readJSON(output, 'directives.json');
  taxonomy = readJSON(output, 'taxonomy.json');
  teachings = readJSON(output, 'teachings.json');
  texts = readJSON(output, 'teachings_text.json');
  packs = readJSON(output, 'packs.json');
  subset = readJSON(output, 'web.json');
  manifest = readJSON(output, 'manifest.json');
  api = await import(pathToFileURL(join(output, 'index.js')).href);
}, 120_000);
afterAll(() => rmSync(temporary, { recursive: true, force: true }));

describe('pinned Scripture and deterministic artifacts', () => {
  it('builds identical complete file inventories and bytes in independent directories', () => {
    const inventory = files(output);
    expect(inventory).toEqual(files(secondOutput));
    expect(inventory).toContain('index.js');
    expect(inventory).toContain('index.d.ts');
    expect(inventory).toContain('catalog.html');
    for (const name of inventory) {
      const bytes = readFileSync(join(output, name));
      expect(bytes.equals(readFileSync(join(secondOutput, name))), name).toBe(true);
      expect(bytes.toString().endsWith('\n'), name).toBe(true);
      expect(bytes.toString(), name).not.toContain('\r');
    }
  });

  it('reproduces the committed dist and fixture artifacts without stale or missing files', () => {
    const targets = [{ generated: output, committed: join(root, 'dist'), authoredFiles: [] }, { generated: fixtureOutput, committed: join(root, 'fixtures/mini'), authoredFiles: ['README.md'] }];
    for (const { generated, committed, authoredFiles } of targets) {
      expect(files(generated), relative(root, committed)).toEqual(files(committed).filter(name => !authoredFiles.includes(name)));
      for (const name of files(generated)) expect(readFileSync(join(generated, name)).equals(readFileSync(join(committed, name))), `${relative(root, committed)}/${name}`).toBe(true);
    }
  });

  it('checks pinned source hashes and records accurate output hashes and compression size', () => {
    expect(Object.keys(manifest.source_hashes).sort()).toEqual(['bible_pericopes.json', 'bible_topics.json', 'web_text.json', 'web_text_integrity.json']);
    for (const [name, expected] of Object.entries(manifest.source_hashes)) expect(sha256(readFileSync(join(root, 'sources', name))), name).toBe(expected);
    expect(manifest.source_hashes['web_text.json']).toBe('d2f6dfef902d61e3dd4fac8b0304b99da270f505d0b01b84940182d95028fc2a');
    for (const [name, expected] of Object.entries(manifest.output_hashes)) expect(sha256(readFileSync(join(output, name))), name).toBe(expected);
    expect(Object.keys(manifest.output_hashes).sort()).toEqual(files(output).filter(name => name !== 'manifest.json'));
    expect(manifest.runtime_gzip_bytes).toBe(gzipSync(readFileSync(join(output, 'index.js')), { level: 9 }).length);
    expect(manifest.runtime_gzip_bytes).toBeLessThanOrEqual(3_000_000);
    expect(manifest.counts.source_verses).toBe(31_103);
    expect(manifest.corpus_version).toBe('c2');
    expect(manifest.referenced_only).toBe(true);
  });

  it.each(['web_text.json', 'web_text_integrity.json', 'bible_topics.json', 'bible_pericopes.json'])('rejects altered bytes in %s before parsing or building', name => {
    const directory = join(temporary, `corrupt-${name}`);
    cpSync(join(root, 'sources'), directory, { recursive: true });
    const filename = join(directory, name);
    writeFileSync(filename, `${readFileSync(filename, 'utf8')} `);
    expect(() => loadSources(directory)).toThrow(`Source hash mismatch: ${name}`);
  });

  it('quotes every directive, anchor, pack, teaching and interpretation from nonempty pinned WEB', () => {
    const retained = new Set<string>();
    const checkReference = (ref: string) => sourceRefs(ref).forEach(verse => retained.add(verse));
    for (const passage of directivePassages(directives)) {
      checkReference(passage.ref);
      expect(passage.text, passage.ref).toBe(sourceText(passage.ref));
    }
    for (const commandment of directives.ten_commandments) commandment.jesus_refs.forEach(checkReference);
    for (const topic of taxonomy) topic.anchors.forEach(checkReference);
    for (const pack of Object.values(packs)) for (const passage of pack.passages) {
      checkReference(passage.ref);
      expect(passage.text, `${pack.topic}: ${passage.ref}`).toBe(sourceText(passage.ref));
    }
    for (const teaching of teachings) {
      checkReference(teaching.ref);
      expect(texts[teaching.id], teaching.id).toBe(sourceText(teaching.ref));
      expect(teaching.est_tokens, teaching.id).toBe(Math.ceil(texts[teaching.id]!.length / 4));
      expect(gospels.has(teaching.ref.slice(0, teaching.ref.lastIndexOf(' '))), teaching.id).toBe(true);
    }
    expect(Object.keys(subset).sort()).toEqual([...retained].sort());
    expect(manifest.counts.verses).toBe(retained.size);
    for (const [ref, text] of Object.entries(subset)) {
      expect(text, ref).toBe(web[ref]);
      expect(text.trim(), ref).not.toBe('');
      expect(text, ref).not.toMatch(/\d+:\d+ /);
    }
  });
});

describe('routing taxonomy, packs and teaching choices', () => {
  it('includes required fallback choices, valid unique IDs and complete topic mappings', () => {
    expect(taxonomy.length).toBeGreaterThanOrEqual(30);
    expect(taxonomy.length).toBeLessThanOrEqual(60);
    expect(teachings.length).toBeGreaterThanOrEqual(40);
    expect(teachings.length).toBeLessThanOrEqual(90);
    const topicIds = taxonomy.map(t => t.id);
    const teachingIds = teachings.map(t => t.id);
    expect(new Set(topicIds).size).toBe(taxonomy.length);
    expect(new Set(teachingIds).size).toBe(teachings.length);
    expect(topicIds).toEqual(expect.arrayContaining(['love_of_neighbor', 'honesty', 'permission_and_authority']));
    expect(teachingIds).toEqual(expect.arrayContaining(['good_samaritan', 'sermon_on_the_mount']));
    expect(Object.keys(packs).sort()).toEqual([...topicIds].sort());
    expect(Object.keys(texts).sort()).toEqual([...teachingIds].sort());
    const commandmentIds = directives.ten_commandments.map(c => c.id);
    for (const topic of taxonomy) {
      expect(topic.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(topic.description.trim(), topic.id).not.toBe('');
      expect(topic.pack, topic.id).toBe(topic.id);
      expect(topic.anchors.length, topic.id).toBeGreaterThanOrEqual(3);
      expect(topic.anchors.length, topic.id).toBeLessThanOrEqual(8);
      for (const id of topic.commandments) expect(commandmentIds, topic.id).toContain(id);
      for (const name of topic.ezra_themes) expect(themes[name]?.category, `${topic.id}: ${name}`).toBe('theme');
      for (const name of topic.ezra_pericopes) expect(pericopes.some(p => p.name === name), `${topic.id}: ${name}`).toBe(true);
    }
    for (const teaching of teachings) {
      expect(teaching.id).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(teaching.description.trim(), teaching.id).not.toBe('');
      for (const id of teaching.topics) expect(topicIds, teaching.id).toContain(id);
    }
    expect(manifest.counts.topics).toBe(taxonomy.length);
    expect(manifest.counts.teachings).toBe(teachings.length);
  });

  it('preserves every anchor once, orders Gospel/NT/OT and keeps all packs within budget', () => {
    for (const topic of taxonomy) {
      const pack = packs[topic.id]!;
      expect(readJSON(output, `packs/${topic.id}.json`), topic.id).toEqual(pack);
      expect(pack.topic).toBe(topic.id);
      expect(pack.passages.length, topic.id).toBeGreaterThan(0);
      const refs = pack.passages.flatMap(p => sourceRefs(p.ref));
      expect(new Set(refs).size, topic.id).toBe(refs.length);
      const anchors = topic.anchors.flatMap(sourceRefs);
      expect(refs, topic.id).toEqual(expect.arrayContaining(anchors));
      const kinds = pack.passages.map(p => rank[p.kind]);
      expect(kinds, topic.id).toEqual([...kinds].sort((a, b) => a - b));
      for (const passage of pack.passages) {
        const book = passage.ref.slice(0, passage.ref.lastIndexOf(' '));
        expect(passage.kind, `${topic.id}: ${passage.ref}`).toBe(gospels.has(book) ? 'jesus_teaching' : ntBooks.has(book) ? 'nt' : 'ot');
      }
      for (const kind of Object.keys(rank) as (keyof typeof rank)[]) {
        const group = pack.passages.filter(p => p.kind === kind).flatMap(p => sourceRefs(p.ref));
        const firstSupplement = group.findIndex(ref => !anchors.includes(ref));
        if (firstSupplement !== -1) expect(group.slice(firstSupplement).some(ref => anchors.includes(ref)), `${topic.id}: anchor after supplement`).toBe(false);
      }
      expect(pack.est_tokens, topic.id).toBe(Math.ceil(pack.passages.map(p => p.text).join(' ').length / 4));
      expect(pack.est_tokens, topic.id).toBeLessThanOrEqual(2500);
      expect(manifest.topic_est_tokens[topic.id]).toBe(pack.est_tokens);
    }
  });

  it('ships a six-topic, eight-teaching fixture with the same data shapes and real text', () => {
    const fixtureTopics = readJSON<Topic[]>(fixtureOutput, 'taxonomy.json');
    const fixtureTeachings = readJSON<Teaching[]>(fixtureOutput, 'teachings.json');
    const fixtureTexts = readJSON<Record<string, string>>(fixtureOutput, 'teachings_text.json');
    const fixturePacks = readJSON<Record<string, Pack>>(fixtureOutput, 'packs.json');
    expect(fixtureTopics).toHaveLength(6);
    expect(fixtureTeachings).toHaveLength(8);
    expect(readJSON<Manifest>(fixtureOutput, 'manifest.json').corpus_version).toBe('c2-mini');
    expect(readJSON(fixtureOutput, 'directives.json')).toEqual(directives);
    for (const topic of fixtureTopics) {
      expect(Object.keys(topic).sort()).toEqual(Object.keys(taxonomy[0]!).sort());
      expect(fixturePacks[topic.id]).toEqual(packs[topic.id]);
    }
    for (const teaching of fixtureTeachings) {
      expect(Object.keys(teaching).sort()).toEqual(Object.keys(teachings[0]!).sort());
      expect(fixtureTexts[teaching.id]).toBe(sourceText(teaching.ref));
      for (const topic of teaching.topics) expect(fixtureTopics.some(t => t.id === topic)).toBe(true);
    }
  });
});

describe('agent interpretations and public API', () => {
  it('keeps all ten commandments and Jesus interpretation references', () => {
    expect(directives.top_rule).toBe("Using Jesus' top directives FIRST and then the Bible text after, derive a probability that the requested action aligns with what Jesus would do.");
    expect(directives.ten_commandments.map(c => c.id)).toEqual(['one_god', 'no_idols', 'name_in_vain', 'sabbath', 'honor_parents', 'murder', 'adultery', 'steal', 'false_witness', 'covet']);
    expect(directives.ten_commandments.map(c => c.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(manifest.counts.commandments).toBe(10);
    expect(directives.great_commandments.map(p => p.ref)).toEqual(['Mark 12:28-31', 'Matthew 22:36-40', 'Luke 10:25-28']);
    expect(directives.new_commandment.ref).toBe('John 13:34-35');
    expect(directives.golden_rule.ref).toBe('Matthew 7:12');
    expect(directives.ten_commandments_passage.ref).toBe('Exodus 20:1-17');
    for (const commandment of directives.ten_commandments) expect(commandment.jesus_refs.length, commandment.id).toBeGreaterThan(0);
  });

  const commandment = (id: string) => directives.ten_commandments.find(c => c.id === id)!;

  it('amended steal guard covers unauthorized destruction, withholding and fraud', () => {
    expect(commandment('steal').agent_gloss).toContain("taking, copying, using, destroying, damaging or withholding money, data, credentials, code, systems or work without the owner's permission, or defrauding (Mark 10:19)");
    expect(commandment('steal').agent_gloss).toContain('Authorization must cover the actual resource and action; technical access alone is not permission.');
    expect(commandment('steal').jesus_refs).toEqual(expect.arrayContaining(['Matthew 19:18', 'Mark 7:21-23', 'Luke 19:8-10']));
  });

  it('amended honor_parents guard keeps family care and adds legitimate human authority', () => {
    const gloss = commandment('honor_parents').agent_gloss;
    expect(gloss).toContain('helping someone dishonor, deceive, exploit or abandon parents to evade genuine responsibilities of care');
    expect(gloss).toContain("and, by extension, defying, deceiving or evading the legitimate authority of the agent's human principal or operator: ignoring stop, resisting shutdown, escaping a sandbox or limit, acting beyond granted permission. Refusing a wrongful instruction or reporting wrongdoing is not breaking it (Acts 5:29)");
  });

  it('amended murder guard protects any person and leaves contested applications to the judge', () => {
    const gloss = commandment('murder').agent_gloss;
    expect(gloss).toContain('the action kills, injures or endangers a person, or directly helps someone do so, including helping someone harm themselves or inciting violence against anyone, whatever they are accused of (Romans 12:19). Killing processes, fiction, history and safety research are not it; lawful public justice, war and necessary defence are left to the judge');
    expect(gloss).not.toMatch(/murderous contempt|innocent human life|Matthew 5:21/);
    expect(commandment('murder').jesus_refs.flatMap(sourceRefs)).toEqual(expect.arrayContaining(['Matthew 5:21', 'Matthew 5:22']));
  });

  it('amended adultery guard covers unfaithfulness, exploitation, coercion and minors', () => {
    const gloss = commandment('adultery').agent_gloss;
    expect(gloss).toContain('facilitating marital unfaithfulness, sexual exploitation or coercion, or anything sexual involving a minor');
    expect(gloss).not.toContain('lustful appropriation');
  });

  it('amended no_idols guard exempts religious art and icons', () => {
    expect(commandment('no_idols').agent_gloss).toContain('Religious art, images and icons are excluded from this guard and left to the judge.');
  });

  it('amended one_god guard permits serving people of other faiths', () => {
    expect(commandment('one_god').agent_gloss.toLowerCase()).toContain('serving people of other faiths is not breaking it');
  });

  it('amended covet guard exempts fair competition', () => {
    expect(commandment('covet').agent_gloss.toLowerCase()).toContain('fair competition is not coveting (luke 12:15)');
  });

  it.each([
    ['steal', 'Mark 10:19'], ['honor_parents', 'Acts 5:29'],
    ['murder', 'Romans 12:19'], ['covet', 'Luke 12:15'],
  ])('amended %s citation %s resolves to one whole pinned WEB verse', (id, ref) => {
    expect(commandment(id).agent_gloss).toContain(ref);
    expect(sourceRefs(ref)).toEqual([ref]);
    expect(api.getVerses([ref])).toEqual([{ ref, text: web[ref] }]);
    expect(web[ref]?.trim()).toBeTruthy();
  });

  it('preserves the sabbath and false-witness agent interpretations', () => {
    expect(commandment('sabbath').agent_gloss).toMatch(/contempt.*rest.*forcing others into endless labor/);
    expect(commandment('sabbath').agent_gloss).toMatch(/Working on a rest day.*helping someone.*not automatically a violation/);
    expect(commandment('sabbath').jesus_refs.flatMap(sourceRefs)).toEqual(expect.arrayContaining(['Mark 2:27', 'Matthew 12:12']));
    expect(commandment('false_witness').agent_gloss).toMatch(/lying to, deceiving or misleading a user or third party, fabricating results or evidence/);
  });

  it('loads the Node-compatible built API and preserves ranges, order and deduplication', () => {
    expect(api.corpusVersion).toBe('c2');
    expect(api.directives).toEqual(directives);
    expect(api.taxonomy).toEqual(taxonomy);
    expect(api.teachings).toEqual(teachings);
    for (const topic of taxonomy) expect(api.getPack(topic.id)).toEqual(packs[topic.id]);
    for (const teaching of teachings) expect(api.getTeachingText(teaching.id)).toBe(texts[teaching.id]);
    const refs = ['John 13:34-35', 'Matthew 5:48-6:2', 'John 13:35'];
    const expected = [...new Set(refs.flatMap(sourceRefs))].map(ref => ({ ref, text: web[ref] }));
    expect(api.getVerses(refs)).toEqual(expected);
    expect(api.getVerses([])).toEqual([]);
  });

  it('bundles the package export for browsers and executes every API without Node globals', async () => {
    const result = await bundle({
      absWorkingDir: root,
      stdin: {
        resolveDir: root,
        sourcefile: 'worker-corpus-probe.js',
        contents: `import { directives, taxonomy, teachings, getPack, getTeachingText, getVerses, corpusVersion } from '@wwjd/corpus';
export function probe() {
  if (typeof globalThis.process !== 'undefined' || typeof globalThis.require !== 'undefined') throw new Error('Unexpected Node globals');
  return { version: corpusVersion, topRule: directives.top_rule, topicCount: taxonomy.length,
    teachingCount: teachings.length, pack: getPack('love_of_neighbor'),
    teaching: getTeachingText('good_samaritan'), verses: getVerses(['John 13:34-35']) };
}`,
      },
      bundle: true, write: false, format: 'iife', globalName: 'corpusProbe',
      platform: 'browser', target: 'es2022', metafile: true,
    });
    expect(Object.keys(result.metafile.inputs)).toContain('dist/index.js');
    for (const entry of Object.values(result.metafile.outputs)) expect(entry.imports).toEqual([]);
    const observed = runInNewContext(`${result.outputFiles[0]!.text}\ncorpusProbe.probe()`, {}, { timeout: 1000 });
    expect(observed).toEqual({
      version: 'c2', topRule: directives.top_rule, topicCount: taxonomy.length,
      teachingCount: teachings.length, pack: packs.love_of_neighbor,
      teaching: texts.good_samaritan,
      verses: sourceRefs('John 13:34-35').map(ref => ({ ref, text: web[ref] })),
    });
  });

  it.each(['unknown', '__proto__', 'constructor', 'toString'])('does not return inherited properties or invented entries for %s', id => {
    expect(api.getPack(id)).toBeUndefined();
    expect(api.getTeachingText(id)).toBeUndefined();
  });

  it.each(['', '__proto__', 'Unknown 1:1', 'John 0:1', 'John 13:0', 'John 13:99', 'John 13:35-34', 'John 13:35-12:1', 'John 13:34 trailing', 'John 13:34\n', 'John 13:34; John 13:35', 'Matthew 5:48-99:1'])('rejects malformed or invalid references instead of silently dropping them: %s', ref => {
    expect(() => api.getVerses([ref])).toThrow();
  });

  it('rejects known but unbundled verses and note-only empty source slots', () => {
    const unbundled = Object.keys(web).find(ref => web[ref]?.trim() && !Object.hasOwn(subset, ref));
    expect(unbundled).toBeDefined();
    expect(() => api.getVerses([unbundled!])).toThrow(/not included in corpus/);
    for (const ref of ['Acts 15:34', 'Acts 24:7', 'Acts 8:37', 'Luke 17:36', 'Romans 16:25']) expect(() => api.getVerses([ref])).toThrow(/not included in corpus/);
  });
});

describe('human review catalog', () => {
  it('lists every guard exclusion under an unnumbered text-and-reference heading without changing the API shape', () => {
    const curation = readJSON<{ ten_commandments: Array<Omit<Commandment, 'text'> & { guard_exclusions: string[] }> }>(join(root, 'curation'), 'directives.json');
    const exclusions = Object.fromEntries(curation.ten_commandments.map(c => [c.id, c.guard_exclusions]));
    expect(exclusions.no_idols?.join(' ')).toMatch(/religious (?:art, images|art|images) and icons/i);
    expect(exclusions.adultery?.join(' ')).toMatch(/remarriage after divorce/i);
    expect(exclusions.sabbath?.join(' ')).toMatch(/which day is (?:the )?Sabbath/i);
    expect(exclusions.murder?.join(' ')).toMatch(/lawful (?:public justice, )?war/i);
    expect(exclusions.murder?.join(' ')).toMatch(/self[- ]defen[sc]e/i);
    const html = readFileSync(join(output, 'catalog.html'), 'utf8');
    const section = html.match(/<section id="commandments">([\s\S]*?)<\/section>/)?.[1];
    expect(section).toBeDefined();
    expect(section).not.toMatch(/<h[1-6]\b[^>]*>\s*\d+[.)]\s/);
    for (const commandment of directives.ten_commandments) {
      expect(Object.keys(commandment).sort(), commandment.id).toEqual(['agent_gloss', 'id', 'jesus_refs', 'n', 'ref', 'short', 'text']);
      expect(api.directives.ten_commandments.find(c => c.id === commandment.id)).not.toHaveProperty('guard_exclusions');
      const recorded = exclusions[commandment.id];
      expect(Array.isArray(recorded), commandment.id).toBe(true);
      expect(recorded!.length, commandment.id).toBeGreaterThan(0);
      const article = section!.match(new RegExp(`<article id="commandment-${commandment.id}">([\\s\\S]*?)<\\/article>`))?.[1];
      expect(article, commandment.id).toBeDefined();
      const heading = article!.match(/<h3>([\s\S]*?)<\/h3>/)?.[1];
      expect(heading, commandment.id).toContain(escapeHTML(commandment.short));
      expect(heading, commandment.id).toContain(escapeHTML(commandment.ref));
      expect(article, commandment.id).toContain('Excluded from this guard');
      const list = article!.match(/<ul>([\s\S]*?)<\/ul>/)?.[1];
      expect(list, commandment.id).toBeDefined();
      for (const exclusion of recorded!) {
        expect(exclusion.trim(), commandment.id).not.toBe('');
        expect(list, commandment.id).toContain(`<li>${escapeHTML(exclusion)}</li>`);
      }
    }
  });

  it('contains every topic, full passage, teaching and commandment without scripts', () => {
    const html = readFileSync(join(output, 'catalog.html'), 'utf8');
    expect(html).not.toMatch(/<script\b/i);
    for (const topic of taxonomy) expect(html).toContain(`id="topic-${topic.id}"`);
    for (const teaching of teachings) expect(html).toContain(`id="teaching-${teaching.id}"`);
    for (const passage of directivePassages(directives)) expect(html).toContain(escapeHTML(passage.text));
    for (const pack of Object.values(packs)) for (const passage of pack.passages) expect(html).toContain(escapeHTML(passage.text));
    for (const text of Object.values(texts)) expect(html).toContain(escapeHTML(text));
    for (const commandment of directives.ten_commandments) expect(html).toContain(escapeHTML(commandment.agent_gloss));
  });

  it('escapes source text and editable metadata, including attribute contexts', () => {
    const attack = '\"><script>alert(1)</script>&\'';
    const escaped = '&quot;&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;&#39;';
    const topic = { ...taxonomy[0]!, id: attack, label: attack, description: attack, commandments: [attack], ezra_themes: [attack], ezra_pericopes: [attack], anchors: [attack] };
    const data = {
      directives: { ...directives, top_rule: attack, great_commandments: [{ ref: attack, text: attack }], ten_commandments: [{ ...directives.ten_commandments[0]!, id: attack, short: attack, ref: attack, agent_gloss: attack, jesus_refs: [attack] }] },
      commandmentExclusions: { [attack]: [attack] },
      taxonomy: [topic], teachings: [{ ...teachings[0]!, id: attack, name: attack, description: attack, ref: attack, topics: [attack] }],
      texts: { [attack]: attack }, packs: { [attack]: { topic: attack, est_tokens: 1, passages: [{ ref: attack, text: attack, kind: 'jesus_teaching' }] } },
      manifest: { ...manifest, corpus_version: attack, source_hashes: { [attack]: attack } },
    };
    const html = renderCatalog(data);
    expect(html).not.toContain(attack);
    expect(html).not.toMatch(/<script\b/i);
    expect(html).toContain(`id="topic-${escaped}"`);
    expect(html).toContain(`id="teaching-${escaped}"`);
    expect(html).toContain(`id="commandment-${escaped}"`);
    expect(html).toContain(`<li>${escaped}</li>`);
    expect(html).toContain(`<p>${escaped}</p>`);
  });
});
