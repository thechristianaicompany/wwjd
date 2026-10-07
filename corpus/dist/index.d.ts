export interface Verse {
    ref: string;
    text: string;
}
export type PassageKind = 'jesus_teaching' | 'nt' | 'ot';
export interface Passage extends Verse {
    kind: PassageKind;
    title?: string;
}
export interface Pack {
    topic: string;
    est_tokens: number;
    passages: Passage[];
}
export interface Commandment extends Verse {
    id: string;
    n: number;
    short: string;
    agent_gloss: string;
    jesus_refs: string[];
}
export interface Directives {
    top_rule: string;
    great_commandments: Verse[];
    new_commandment: Verse;
    golden_rule: Verse;
    ten_commandments: Commandment[];
    ten_commandments_passage: Verse;
}
export interface Topic {
    id: string;
    label: string;
    description: string;
    commandments: string[];
    ezra_themes: string[];
    ezra_pericopes: string[];
    anchors: string[];
    pack: string;
}
export interface Teaching {
    id: string;
    name: string;
    ref: string;
    description: string;
    topics: string[];
    est_tokens: number;
}
export declare const directives: Directives;
export declare const taxonomy: Topic[];
export declare const teachings: Teaching[];
export declare const corpusVersion = "c2";
export declare function getPack(id: string): Pack | undefined;
export declare function getTeachingText(id: string): string | undefined;
/** Expand ranges in caller order, deduplicate verses, and reject anything absent from the referenced subset. */
export declare function getVerses(refs: readonly string[]): Verse[];
