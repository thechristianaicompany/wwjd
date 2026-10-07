import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chapterIndex, expandReference } from './references.mjs';
export const sourceHashes = {
  'web_text.json': 'd2f6dfef902d61e3dd4fac8b0304b99da270f505d0b01b84940182d95028fc2a',
  'web_text_integrity.json': '5a1485ca8afd34a958f51ecca2bb3a977684de9f9d24573253f494a26b6e3701',
  'bible_topics.json': 'd4df7026c67615dfd1875962f88c5e8527fe3c4ad9f59ce687b3b2a0374f86a9',
  'bible_pericopes.json': '3667940917a53c65f12c790a182180840fca59e78a91255dc0b581fd4a90baef',
};
export const root = fileURLToPath(new URL('../', import.meta.url));
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function loadSources(directory = `${root}sources/`) {
  const files = {};
  for (const [name, expected] of Object.entries(sourceHashes)) {
    const bytes = readFileSync(`${directory}/${name}`);
    if (hash(bytes) !== expected) throw new Error(`Source hash mismatch: ${name}`);
    files[name] = JSON.parse(bytes);
  }
  const web = files['web_text.json'], themes = files['bible_topics.json'], pericopes = files['bible_pericopes.json'];
  const chapters = chapterIndex(web);
  const resolve = ref => expandReference(ref, chapters);
  const text = ref => resolve(ref).map(r => {
    if (typeof web[r] !== 'string' || !web[r].trim()) throw new Error(`Empty or missing Scripture: ${r}`);
    return web[r];
  }).join(' ');
  return { web, themes, pericopes, chapters, resolve, text };
}
export function stableJSON(value) {
  const sorted = item => Array.isArray(item) ? item.map(sorted) : item && typeof item === 'object'
    ? Object.fromEntries(Object.keys(item).sort().map(k => [k, sorted(item[k])])) : item;
  return `${JSON.stringify(sorted(value), null, 2)}\n`;
}
