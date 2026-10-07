# Pinned sources

The corpus uses **World English Bible Classic, 2026-09-29**, public-domain text. The supplied clean, reviewed export removes footnotes; it does not use the contaminated Ezra Worker text. Origin: the reviewed `candidate-complete` output of the 2026-10-02 Ezra verse-repair pass. No downloads or live API calls are needed to rebuild.

| File | SHA-256 |
|---|---|
| web_text.json | d2f6dfef902d61e3dd4fac8b0304b99da270f505d0b01b84940182d95028fc2a |
| web_text_integrity.json | 5a1485ca8afd34a958f51ecca2bb3a977684de9f9d24573253f494a26b6e3701 |
| bible_topics.json | d4df7026c67615dfd1875962f88c5e8527fe3c4ad9f59ce687b3b2a0374f86a9 |
| bible_pericopes.json | 3667940917a53c65f12c790a182180840fca59e78a91255dc0b581fd4a90baef |

The builder verifies all four file hashes before producing output. There are 31,103 reference slots; five have only a note in the original source and therefore have empty cleaned text: Acts 15:34, Acts 24:7, Acts 8:37, Luke 17:36, Romans 16:25. Empty text is rejected whenever a pack, anchor, directive, Jesus reference, or teaching selects it.

Ezra topic and pericope mappings are **AGPL-3.0**. They are byte-identical to the supplied `~/ezra-bible-data/` originals. The included `EZRA-LICENSE` and `EZRA-README.md` preserve the upstream licence and explanation of how tags were produced. The README's historical counts differ from this pinned snapshot: this build measures **386 topics (156 themes, 189 stories, 41 parables), 709 pericope instances**. Source verification uses the data, not those historical README counts.

Curated anchors, routing descriptions and agent glosses live in `../curation/`; these are editorial selections and interpretations, not translated Scripture. `ezra_selections` lists deliberately selected supplementary references and must resolve within the topic's named Ezra themes or pericopes. This field is internal to the build; the public taxonomy uses the contract's fields only.

Canonical references retain the pinned source's spelling, including `Psalms`. Ranges use `Book chapter:start-end` or `Book startChapter:startVerse-endChapter:endVerse`. Verse text is never trimmed, rewritten or normalized; range text joins complete verse strings with one space.
