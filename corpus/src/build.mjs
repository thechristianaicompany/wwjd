import { mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import { build as bundle } from 'esbuild';
import ts from 'typescript';
import { loadSources, root, hash, sourceHashes, stableJSON } from './source.mjs';
import { catalog } from './catalog.mjs';

const GOSPELS = ['Matthew', 'Mark', 'Luke', 'John'];
const NT = [...GOSPELS, 'Acts', 'Romans', '1 Corinthians', '2 Corinthians', 'Galatians', 'Ephesians', 'Philippians', 'Colossians', '1 Thessalonians', '2 Thessalonians', '1 Timothy', '2 Timothy', 'Titus', 'Philemon', 'Hebrews', 'James', '1 Peter', '2 Peter', '1 John', '2 John', '3 John', 'Jude', 'Revelation'];
const kindRank = { jesus_teaching: 0, nt: 1, ot: 2 };
export const tokens = text => Math.ceil(text.length / 4);
const book = ref => ref.slice(0, ref.lastIndexOf(' '));
const kind = ref => GOSPELS.includes(book(ref)) ? 'jesus_teaching' : NT.includes(book(ref)) ? 'nt' : 'ot';
const readCuration = name => JSON.parse(readFileSync(join(root, 'curation', `${name}.json`), 'utf8'));
const assert = (ok, message) => { if (!ok) throw new Error(message); };
function uniqueIds(rows, label) {
  assert(new Set(rows.map(row => row.id)).size === rows.length, `Duplicate ${label} id`);
  for (const row of rows) assert(/^[a-z][a-z0-9_]*$/.test(row.id), `Invalid ${label} id: ${row.id}`);
}

/** Merge consecutive verses without changing curated priority or crossing a chapter. */
function mergePassages(refs, source) {
  const ranges = [];
  for (const ref of refs) {
    const prior = ranges.at(-1);
    const colon = ref.lastIndexOf(':'), chapter = ref.slice(0, colon), verse = Number(ref.slice(colon + 1));
    if (prior && prior.chapter === chapter && prior.end + 1 === verse) prior.end = verse;
    else ranges.push({ chapter, start: verse, end: verse });
  }
  return ranges.map(r => {
    const ref = `${r.chapter}:${r.start}${r.end === r.start ? '' : `-${r.end}`}`;
    return { ref, kind: kind(`${r.chapter}:${r.start}`), text: source.text(ref) };
  });
}
export function makePack(topic, source) {
  const mapped = new Set([
    ...topic.ezra_themes.flatMap(name => source.themes[name].verse_refs),
    ...source.pericopes.filter(p => topic.ezra_pericopes.includes(p.name)).flatMap(p => p.verse_refs),
  ]);
  const anchors = [...new Set(topic.anchors.flatMap(source.resolve))];
  anchors.forEach(source.text);
  const supplemental = [...new Set((topic.ezra_selections ?? []).flatMap(source.resolve))].filter(ref => !anchors.includes(ref));
  for (const ref of supplemental) {
    assert(mapped.has(ref), `Unmapped Ezra supplement: ${topic.id}: ${ref}`);
    source.text(ref);
  }
  const selected = [...anchors];
  assert(tokens(selected.map(source.text).join(' ')) <= 2500, `Anchors exceed budget: ${topic.id}`);
  for (const ref of supplemental) {
    if (tokens([...selected, ref].map(source.text).join(' ')) <= 2500) selected.push(ref);
  }
  const passages = Object.keys(kindRank).flatMap(k => [anchors, selected.slice(anchors.length)]
    .flatMap(group => mergePassages(group.filter(r => kind(r) === k), source)));
  return { topic: topic.id, est_tokens: tokens(passages.map(p => p.text).join(' ')), passages };
}

export async function buildCorpus({ fixture = false, destination } = {}) {
  const source = loadSources();
  const rawDirectives = readCuration('directives');
  let topics = readCuration('topics');
  let teachingRows = readCuration('teachings');
  if (fixture) {
    const topicIds = ['love_of_neighbor', 'honesty', 'permission_and_authority', 'theft', 'stewardship', 'protecting_life'];
    topics = topics.filter(t => topicIds.includes(t.id));
    const teachingIds = ['good_samaritan', 'sermon_on_the_mount', 'zacchaeus', 'foot_washing', 'temptation_in_the_wilderness', 'cleansing_of_the_temple', 'render_to_caesar', 'woman_caught_in_adultery'];
    teachingRows = teachingRows.filter(t => teachingIds.includes(t.id)).map(t => ({...t, topics: t.topics.filter(id => topicIds.includes(id))}));
    assert(topics.length === 6 && teachingRows.length === 8, 'Fixture needs exactly 6 topics and 8 teachings');
  } else {
    assert(topics.length >= 30 && topics.length <= 60, 'Expected 30–60 topics');
    assert(teachingRows.length >= 40 && teachingRows.length <= 90, 'Expected 40–90 teachings');
  }
  uniqueIds(topics, 'topic'); uniqueIds(teachingRows, 'teaching'); uniqueIds(rawDirectives.ten_commandments, 'commandment');
  const commandmentExclusions = Object.fromEntries(rawDirectives.ten_commandments.map(c => {
    assert(Array.isArray(c.guard_exclusions) && c.guard_exclusions.length > 0
      && c.guard_exclusions.every(text => typeof text === 'string' && text.trim()),
    `Missing guard exclusions: ${c.id}`);
    return [c.id, c.guard_exclusions];
  }));
  const textEntry = item => ({ ...item, text: source.text(item.ref) });
  const directives = { ...rawDirectives,
    great_commandments: rawDirectives.great_commandments.map(textEntry),
    new_commandment: textEntry(rawDirectives.new_commandment),
    golden_rule: textEntry(rawDirectives.golden_rule),
    ten_commandments_passage: textEntry(rawDirectives.ten_commandments_passage),
    // Exclusions are catalog curation; preserve the public directives shape.
    ten_commandments: rawDirectives.ten_commandments.map(({ guard_exclusions, ...c }) => textEntry(c)),
  };
  const commandmentIds = directives.ten_commandments.map(c => c.id);
  for (const topic of topics) {
    assert(topic.pack === topic.id, `Pack id mismatch: ${topic.id}`);
    assert(topic.anchors.length >= 3 && topic.anchors.length <= 8, `Expected 3–8 anchors: ${topic.id}`);
    for (const id of topic.commandments) assert(commandmentIds.includes(id), `Unknown commandment: ${id}`);
    for (const name of topic.ezra_themes) assert(source.themes[name]?.category === 'theme', `Unknown Ezra theme: ${name}`);
    for (const name of topic.ezra_pericopes) assert(source.pericopes.some(p => p.name === name), `Unknown Ezra pericope: ${name}`);
  }
  const taxonomy = topics.map(({ezra_selections, ...topic}) => topic).sort((a,b) => a.id.localeCompare(b.id, 'en'));
  const packs = Object.fromEntries(topics.map(topic => [topic.id, makePack(topic, source)]));
  const texts = Object.fromEntries(teachingRows.map(t => [t.id, source.text(t.ref)]));
  const teachings = teachingRows.map(t => ({ ...t, est_tokens: tokens(texts[t.id]) })).sort((a,b)=>a.id.localeCompare(b.id, 'en'));
  for (const t of teachings) {
    assert(GOSPELS.includes(book(source.resolve(t.ref)[0])), `Non-Gospel teaching: ${t.id}`);
    for (const id of t.topics) assert(topics.some(topic => topic.id === id), `Unknown teaching topic: ${t.id}: ${id}`);
  }
  for (const id of ['love_of_neighbor','honesty','permission_and_authority']) assert(packs[id], `Missing fallback topic: ${id}`);
  for (const id of ['good_samaritan','sermon_on_the_mount']) assert(texts[id], `Missing fallback teaching: ${id}`);
  const refs = new Set();
  const retain = ref => { source.text(ref); source.resolve(ref).forEach(r => refs.add(r)); };
  [...directives.great_commandments,directives.new_commandment,directives.golden_rule,directives.ten_commandments_passage,...directives.ten_commandments].forEach(p => retain(p.ref));
  directives.ten_commandments.forEach(c => c.jesus_refs.forEach(retain));
  taxonomy.forEach(t => t.anchors.forEach(retain));
  Object.values(packs).forEach(p => p.passages.forEach(p => retain(p.ref)));
  teachings.forEach(t => retain(t.ref));
  const web = Object.fromEntries([...refs].sort().map(ref => [ref, source.web[ref]]));
  for (const [ref, text] of Object.entries(web)) assert(!/\d+:\d+ /.test(text), `Note marker in ${ref}`);
  const output = destination ?? join(root, fixture ? 'fixtures/mini' : 'dist');
  mkdirSync(join(output, 'packs'), { recursive: true });
  // Remove only generated pack JSONs for topics no longer in this build.
  for (const name of readdirSync(join(output, 'packs'))) if (name.endsWith('.json') && !Object.hasOwn(packs, name.slice(0,-5))) unlinkSync(join(output, 'packs', name));
  const files = { 'directives.json': directives, 'taxonomy.json': taxonomy, 'teachings.json': teachings, 'teachings_text.json': texts, 'web.json': web, 'chapters.json': source.chapters, 'packs.json': packs };
  for (const [id, pack] of Object.entries(packs)) files[`packs/${id}.json`] = pack;
  for (const [name, value] of Object.entries(files)) writeFileSync(join(output, name), stableJSON(value));
  const manifest = {
    corpus_version: fixture ? 'c2-mini' : 'c2', build_version: 1,
    source_hashes: sourceHashes,
    counts: { source_verses: Object.keys(source.web).length, source_topics: Object.keys(source.themes).length, source_pericopes: source.pericopes.length, topics: taxonomy.length, teachings: teachings.length, verses: refs.size, commandments: commandmentIds.length },
    topic_est_tokens: Object.fromEntries(Object.entries(packs).map(([id,p])=>[id,p.est_tokens])),
    output_hashes: Object.fromEntries(Object.keys(files).map(name=>[name,hash(readFileSync(join(output,name)))])),
    referenced_only: true,
  };
  if (!fixture) {
    // Resolve static JSON imports to this output even in deterministic temporary builds.
    const result = await bundle({ entryPoints: [join(root,'src/index.ts')], bundle:true, write:false, format:'esm', platform:'neutral', target:'es2022', minify:true, legalComments:'none', plugins:[{name:'corpus-output',setup(build){build.onResolve({filter:/^\.\.\/dist\/.*\.json$/},args=>({path:join(output,args.path.split('/').at(-1))}));}}] });
    const runtime = result.outputFiles[0].contents;
    writeFileSync(join(output,'index.js'),runtime);
    const program = ts.createProgram([join(root,'src/index.ts')], { declaration: true, emitDeclarationOnly: true, allowJs: true, resolveJsonModule: true, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, target:ts.ScriptTarget.ES2022, esModuleInterop:true, skipLibCheck:true });
    let declaration;
    program.emit(undefined,(name,text)=>{if(name.endsWith('/index.d.ts'))declaration=text;});
    assert(declaration,'Could not generate package declarations');
    writeFileSync(join(output,'index.d.ts'),declaration);
    manifest.runtime_gzip_bytes = gzipSync(runtime,{level:9}).length;
    manifest.runtime_bytes = runtime.length;
    manifest.output_hashes['index.js'] = hash(runtime);
    manifest.output_hashes['index.d.ts'] = hash(declaration);
    assert(manifest.runtime_gzip_bytes <= 3_000_000,'Runtime exceeds 3 MB gzip');
  }
  writeFileSync(join(output,'catalog.html'),catalog({directives,taxonomy,teachings,texts,packs,manifest,commandmentExclusions}));
  manifest.output_hashes['catalog.html'] = hash(readFileSync(join(output,'catalog.html')));
  writeFileSync(join(output,'manifest.json'),stableJSON(manifest));
  return manifest;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  console.log(stableJSON(await buildCorpus({fixture:process.argv.includes('--fixture')})));
}
