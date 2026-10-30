import { concatText, sliceText, normalizeSentenceSource, getSourceRanges } from "./text_provenance.js";
import { bindInlineMath } from "./inline_math.js";

const segmenter = new Intl.Segmenter("en", { granularity: "sentence" });
const proseKinds = new Set(["paragraph", "caption", "footnote"]);
export const normalizeSentenceText = (text) => normalizeSentenceSource({ text: String(text || ""), textSpans: [] }).text;

// Keep offsets unchanged while preventing sentence breaks inside common paper abbreviations.
// shortcut: uncommon abbreviations remain ambiguous; add a documented case when a paper exposes one.
function protectPeriods(text) {
  const protect = (match) => match.replace(/\./g, "\uE000");
  return text
    .replace(/\b(?:e\.g|i\.e|a\.k\.a)\./gi, protect)
    .replace(/\b(?:figs?|eqs?|secs?|sect|ch|nos?|vol|pp?|dr|prof|mr|mrs|ms|vs|cf|viz)\./gi, protect)
    .replace(/\b(?:et\s+al|etc)\.(?=\s+(?:\p{Ll}|\d|\[|\())/giu, protect)
    .replace(/\b(?:[A-Z]\.\s+)+[A-Z]\.(?=\s+[A-Z][a-z])/g, protect)
    .replace(/(^|[\[(]\s*|\b(?:by|from|author)\s+)(?:[A-Z]\.\s*)+(?=[A-Z][a-z])/g, protect)
    .replace(/(?<=\d)\.(?=\d)/g, protect);
}

function complete(text, next) {
  const protectedText = protectPeriods(text + (next ? " " + next : "")).slice(0, text.length);
  return /[.!?。！？][\])}"'”’»」』】]*(?:\s*\[[\d,;\s–-]+\])*$/u.test(protectedText);
}

function union(boxes) {
  if (!boxes.length) return undefined;
  const x = Math.min(...boxes.map((box) => box.x));
  const y = Math.min(...boxes.map((box) => box.y));
  return { x, y, width: Math.max(...boxes.map((box) => box.x + box.width)) - x,
    height: Math.max(...boxes.map((box) => box.y + box.height)) - y };
}

function captionContinuation(previous, next) {
  if (previous.kind !== "caption" || next.kind !== "paragraph" ||
      !/^\p{Ll}/u.test(normalizeSentenceText(next.text)) || previous.column !== next.column) return false;
  if (!previous.bbox || !next.bbox) return false;
  const gap = next.bbox.y - previous.bbox.y - previous.bbox.height;
  return gap >= -2 && gap <= Math.max(24, Math.min(previous.bbox.height, next.bbox.height));
}

export function createSentenceUnits(page) {
  const units = [];
  const counts = new Map();
  let run = [];
  let runText = "";
  let runSource = { text: "", textSpans: [] };

  const flush = () => {
    if (!run.length) return;
    const ranges = [...segmenter.segment(protectPeriods(runText))]
      .map(({ index, segment }) => ({ start: index, end: index + segment.length }));
    for (let i = 1; i < ranges.length; i++) {
      const citation = runText.slice(ranges[i].start, ranges[i].end).match(/^(?:\s*\[[\d,;\s–-]+\])+\s*/u);
      if (citation) {
        ranges[i].start += citation[0].length;
        ranges[i - 1].end = ranges[i].start;
      }
    }
    for (const range of ranges) {
      const index = range.start;
      const source = runText.slice(index, range.end);
      const leading = source.length - source.trimStart().length;
      const start = index + leading;
      const end = index + source.trimEnd().length;
      if (end <= start) continue;
      const sources = run.filter((part) => part.end > start && part.start < end).map((part) => part.block);
      const first = sources[0];
      const count = (counts.get(first.id) || 0) + 1;
      counts.set(first.id, count);
      units.push({ ...first, ...sliceText(runSource, start, end), id: `${first.id}-s${count}`,
        kind: first.kind, unitType: "sentence", sourceBlockIds: sources.map((block) => block.id),
        sourceIndices: [...new Set(sources.flatMap((block) => block.sourceIndices || []))],
        sourceRanges: getSourceRanges(runSource, start, end),
        bbox: union(sources.map((block) => block.bbox).filter(Boolean)) });
    }
    run = [];
    runText = "";
    runSource = { text: "", textSpans: [] };
  };

  for (const block of page.blocks || []) {
    if (!proseKinds.has(block.kind)) {
      flush();
      units.push({ ...block, sourceBlockIds: [block.id], sourceRanges: getSourceRanges(block), unitType: "block" });
      continue;
    }
    const normalized = normalizeSentenceSource(block);
    const text = normalized.text;
    if (!text) { flush(); continue; }
    const previous = run.at(-1)?.block;
    if (previous && (complete(runText, text) ||
        (previous.kind !== block.kind && !captionContinuation(previous, block)))) flush();
    const joiner = run.length && !/[-\u00ad]\s*$/.test(String(previous?.text || "")) ? " " : "";
    runText += joiner;
    const start = runText.length;
    runText += text;
    runSource = concatText([runSource, normalized], joiner);
    run.push({ block, start, end: runText.length });
  }
  flush();
  return units;
}

// A sentence shared by two pages has one identity and one cached translation.
export function createDocumentSentencePages(pages) {
  const result = pages.map((page) => ({ ...page, blocks: createSentenceUnits(page).map((unit) => ({
    ...unit, ownerPageNumber: page.pageNumber, sourcePageNumbers: [page.pageNumber],
  })) }));
  const floating = new Set(["footnote", "caption", "table"]);
  for (let i = 0; i < result.length - 1; i++) {
    const before = result[i], after = result[i + 1];
    if (after.pageNumber !== before.pageNumber + 1) continue;
    let left = before.blocks.length - 1, right = 0;
    while (left >= 0 && floating.has(before.blocks[left].kind)) left--;
    while (right < after.blocks.length && floating.has(after.blocks[right].kind)) right++;
    const first = before.blocks[left], next = after.blocks[right];
    if (first?.kind !== "paragraph" || next?.kind !== "paragraph" ||
        complete(first.text, next.text) || /^(?:[•▪●]|\(?\d+[.)](?:\s|$)|\([a-z]\)(?:\s|$))/i.test(next.text)) continue;
    const tag = (unit, pageNumber) => ({ ...unit, textSpans: (unit.textSpans || []).map((span) => ({
      ...span, pageNumber: span.pageNumber ?? pageNumber,
    })) });
    const lastBlockId = first.sourceBlockIds.at(-1);
    const rawEnd = pages[i].blocks.find((block) => block.id === lastBlockId)?.text || first.text;
    const joined = concatText([tag(first, first.ownerPageNumber), tag(next, after.pageNumber)], /[-\u00ad]\s*$/.test(rawEnd) ? "" : " ");
    Object.assign(first, joined, {
      sourceRanges: getSourceRanges(joined),
      sourceBlockIds: [...new Set([...first.sourceBlockIds, ...next.sourceBlockIds])],
      sourcePageNumbers: [...new Set([...first.sourcePageNumbers, ...next.sourcePageNumbers])],
    });
    after.blocks[right] = first;
  }
  const bound = new Set();
  for (const page of result) for (const unit of page.blocks) if (!bound.has(unit)) {
    bound.add(unit);
    if (unit.unitType === "sentence" || unit.kind === "heading") bindInlineMath(unit, pages);
  }
  return result;
}
