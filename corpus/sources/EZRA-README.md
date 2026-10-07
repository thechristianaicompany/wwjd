# Ezra Bible Data

Authoritative Bible verses indexed by topic, story, and parable.

Every verse of the Protestant canon (World English Bible) tagged with applicable
themes (Faith, Hope, Forgiveness, ...), named narrative episodes (Noah's Ark,
David and Goliath, ...), and parables of Jesus.

## Files

| File | Shape | Size |
|------|-------|------|
| `bible_verses.json`     | `[{ref, book, chapter, verse, topics:[...], pericopes:[...]}, ...]` | 4.6 MB |
| `bible_topics.json`     | `{topic: {category, verse_count, verse_refs:[...]}}` | 1.2 MB |
| `bible_pericopes.json`  | `[{name, category, book, verse_range, verse_refs:[...], topics:[...]}, ...]` | 458 KB |
| `discovered_topics.json`| `[{name, count, occurrences:[...]}, ...]` — review queue of names emitted by tagging agents that aren't yet in the canonical taxonomy | 295 KB |

## Numbers

- **66 books**, **1,189 chapters**, **~31,100 verses** (full Protestant canon)
- **23,390 verses** carry at least one topic tag
- **710 pericope instances** across the corpus
- **387 canonical labels**: 157 themes + 189 stories + 41 parables
- **773 entries** in `discovered_topics.json` for review and possible promotion

Empty topic arrays on a verse are intentional: genealogies, geographical lists,
ritual minutiae. They mean *"tagged and judged to carry no landing-page theme"*,
not *"untagged"*.

## Schema

### `bible_verses.json`
```json
{
  "ref": "John 3:16",
  "book": "John",
  "chapter": 3,
  "verse": 16,
  "topics": ["God's Love", "Faith", "Eternal Life"],
  "pericopes": ["Nicodemus and Being Born Again"]
}
```

### `bible_topics.json`
```json
{
  "Faith": {
    "category": "theme",
    "verse_count": 1138,
    "verse_refs": ["Genesis 15:6", "Habakkuk 2:4", "Romans 1:17", ...]
  }
}
```

### `bible_pericopes.json`
```json
{
  "name": "Sermon on the Mount",
  "category": "story",
  "book": "Matthew",
  "verse_range": "Matthew 5:1-7:29",
  "verse_refs": ["Matthew 5:1", "Matthew 5:2", ...],
  "topics": ["Wisdom", "Beatitudes", "Kingdom of God"]
}
```

## Source

- **Translation**: [World English Bible (WEB)](https://ebible.org/web/) — public domain.
- **Tagging**: Each chapter classified by a large language model (Claude Opus / Claude Sonnet / Gemini Pro) against a curated taxonomy. Multiple independent passes; LLM-disagreement surfaces in `discovered_topics.json`.

## License

This data is released under **AGPL-3.0** (see `LICENSE`). The WEB translation
itself is public domain; this license covers the topic/pericope mappings, which
are an original derivative work.

In practice: free to use, including commercially. If you modify the data or
build a service that distributes it, your service must also be AGPL-3.0.
