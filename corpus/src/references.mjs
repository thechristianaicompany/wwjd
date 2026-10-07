/** Strict single-book references: John 13:34, Luke 10:25-37, Matthew 5:1-7:29. */
export function expandReference(reference, chapterLengths) {
  const match = /^([1-3] )?[A-Za-z]+(?: [A-Za-z]+)* \d+:\d+(?:-(?:\d+:)?\d+)?$/.test(reference)
    && /^(.*?) (\d+):(\d+)(?:-(?:(\d+):)?(\d+))?$/.exec(reference);
  if (!match) throw new RangeError(`Invalid Scripture reference: ${reference}`);
  const [, book, chapter, verse, endChapter, endVerse] = match;
  const startC = Number(chapter), startV = Number(verse);
  const endC = Number(endChapter ?? chapter), endV = Number(endVerse ?? verse);
  if (startC < 1 || startV < 1 || endV < 1 || endC < startC || (endC === startC && endV < startV))
    throw new RangeError(`Invalid Scripture range: ${reference}`);
  if (startV > (chapterLengths[`${book} ${startC}`] ?? 0) || endV > (chapterLengths[`${book} ${endC}`] ?? 0))
    throw new RangeError(`Unknown Scripture reference: ${reference}`);
  const refs = [];
  for (let c = startC; c <= endC; c++) {
    const last = chapterLengths[`${book} ${c}`];
    if (!last) throw new RangeError(`Unknown Scripture chapter: ${book} ${c}`);
    for (let v = c === startC ? startV : 1; v <= (c === endC ? endV : last); v++) refs.push(`${book} ${c}:${v}`);
  }
  return refs;
}

export function chapterIndex(web) {
  const chapters = {};
  for (const ref of Object.keys(web)) {
    const split = ref.lastIndexOf(':');
    const chapter = ref.slice(0, split), verse = Number(ref.slice(split + 1));
    chapters[chapter] = Math.max(chapters[chapter] ?? 0, verse);
  }
  return chapters;
}
