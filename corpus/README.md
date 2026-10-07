# @wwjd/corpus

Pinned WEB Scripture for WWJD: Jesus' directives, alignment topics, Gospel teachings, and bounded topic packs. The catalog is a human review surface; mechanical fidelity checks do not constitute theological approval.

From the repository root with Node 22.22+ and pnpm 11.9:

```sh
pnpm install
pnpm --filter @wwjd/corpus fixture
pnpm --filter @wwjd/corpus build
pnpm --filter @wwjd/corpus test
pnpm --filter @wwjd/corpus typecheck
```

Open `corpus/dist/catalog.html` directly. No server, script, remote font or network request is required. Rebuilds need only the vendored sources and pinned development dependencies.

```ts
import { directives, taxonomy, teachings, getPack, getTeachingText, getVerses, corpusVersion } from '@wwjd/corpus';
getPack('honesty');                  // Pack | undefined
getTeachingText('good_samaritan');   // string | undefined
getVerses(['Mark 12:28-31']);        // Array<{ ref: string; text: string }>
```

`getVerses` expands single-book ranges, preserves requested order and removes duplicate verses. It throws `RangeError` on malformed references or any verse absent from the referenced subset; no silent empty text. `getPack` and `getTeachingText` return `undefined` for unknown ids. Consumers should treat returned corpus data as read-only.

`src/index.ts` uses static JSON imports. The build bundles that entry into committed `dist/index.js`, which imports no filesystem or Node APIs and works in Node and Cloudflare's esbuild pipeline. `dist/index.d.ts` describes the same API. The full source Bible remains in `sources/`; only referenced verse text is bundled. `chapters.json` carries chapter lengths (no additional verse text) for strict range validation. Matthew 5–7 is included through the complete fallback Sermon on the Mount teaching. Additional chapter context outside the referenced subset is unavailable and must not be fabricated.

The build reserves all anchors, then adds explicitly curated Ezra supplements while respecting 2,500 estimated tokens. Priority is Jesus' teaching, remaining New Testament, then Old Testament; within each group, anchors precede supplements. Adjacent verses are joined only within a chapter and priority group. The estimate is `ceil(joinedText.length / 4)`, matching JavaScript string length in the engine contract. Teaching estimates use the complete teaching text; the full Sermon is intentionally longer than the per-topic cap.

`manifest.json` records sources, counts, output hashes, token estimates, and the gzip size of the actual self-contained runtime module. No timestamp is embedded, so identical input and tools produce identical output. `packs.json` is the runtime aggregate; `packs/<id>.json` preserves the reviewable contract files.

`fixtures/mini/` uses the same data shapes with six topics, eight teachings and real pinned verse text. It is a development fixture, version `c2-mini`, not the full production catalog.

See [source provenance](sources/SOURCES.md). WEB text is public domain; Ezra mappings and this package are AGPL-3.0.

The `c2` commandment glosses apply the approved shared-ground guard scope. Per-commandment `guard_exclusions` are curation-only: the generated catalog lists them, while the exported `directives.json` shape stays unchanged. Runtime glosses themselves state the amended exclusions. Commandment `n` remains internal ordering; the catalog uses text and references. Final wording is for the user's theology sign-off.
