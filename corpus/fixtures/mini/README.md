# WWJD mini corpus · c2-mini

Development fixture: **6 topics, 8 teachings, 10 commandment glosses, 320 referenced verses**. Every quotation is joined verbatim from the pinned clean WEB source; source hashes are in `manifest.json`.

Read `directives.json`, `taxonomy.json`, `teachings.json`, `teachings_text.json`, `web.json`, and `packs/<topic>.json` using the CONTRACTS §2 shapes. `packs.json` is an equivalent aggregate convenience map. `chapters.json` contains canonical chapter lengths only. `catalog.html` opens directly without scripts.

Fallback topic ids: `love_of_neighbor`, `honesty`, `permission_and_authority`. Other fixture topics: `theft`, `stewardship`, `protecting_life`. Fallback teaching ids: `good_samaritan`, `sermon_on_the_mount`. The Sermon is complete Matthew 5:1–7:29; the 2,500-token cap applies to topic packs, not complete teachings.

The final package API uses `getVerses(refs): Array<{ref, text}>`, expanding ranges, deduplicating in caller order, and throwing on missing text; `getPack(id)` and `getTeachingText(id)` return `undefined` for an unknown id. The fixture is data-only so dependent lanes can implement against these shapes before the full package lands.
