import rawDirectives from '../dist/directives.json' with { type: 'json' };
import rawTaxonomy from '../dist/taxonomy.json' with { type: 'json' };
import rawTeachings from '../dist/teachings.json' with { type: 'json' };
import rawPacks from '../dist/packs.json' with { type: 'json' };
import rawTexts from '../dist/teachings_text.json' with { type: 'json' };
import rawWeb from '../dist/web.json' with { type: 'json' };
import rawChapters from '../dist/chapters.json' with { type: 'json' };
import { expandReference } from './references.mjs';

export interface Verse { ref: string; text: string }
export type PassageKind = 'jesus_teaching' | 'nt' | 'ot';
export interface Passage extends Verse { kind: PassageKind; title?: string }
export interface Pack { topic: string; est_tokens: number; passages: Passage[] }
export interface Commandment extends Verse { id: string; n: number; short: string; agent_gloss: string; jesus_refs: string[] }
export interface Directives {
  top_rule: string;
  great_commandments: Verse[];
  new_commandment: Verse;
  golden_rule: Verse;
  ten_commandments: Commandment[];
  ten_commandments_passage: Verse;
}
export interface Topic {
  id: string; label: string; description: string; commandments: string[];
  ezra_themes: string[]; ezra_pericopes: string[]; anchors: string[]; pack: string;
}
export interface Teaching { id: string; name: string; ref: string; description: string; topics: string[]; est_tokens: number }
export const directives: Directives = rawDirectives;
export const taxonomy: Topic[] = rawTaxonomy;
export const teachings: Teaching[] = rawTeachings;
export const corpusVersion = 'c2';
const packs = rawPacks as Record<string, Pack>;
const texts: Record<string, string> = rawTexts;
const web: Record<string, string> = rawWeb;
export function getPack(id: string): Pack | undefined {
  return Object.hasOwn(packs, id) ? packs[id] : undefined;
}
export function getTeachingText(id: string): string | undefined {
  return Object.hasOwn(texts, id) ? texts[id] : undefined;
}
/** Expand ranges in caller order, deduplicate verses, and reject anything absent from the referenced subset. */
export function getVerses(refs: readonly string[]): Verse[] {
  const unique = new Set<string>();
  for (const ref of refs) for (const verse of expandReference(ref, rawChapters)) unique.add(verse);
  return [...unique].map(ref => {
    if (!Object.hasOwn(web, ref) || !web[ref]) throw new RangeError(`Verse is not included in corpus ${corpusVersion}: ${ref}`);
    return { ref, text: web[ref] as string };
  });
}
