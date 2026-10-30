// Offsets use UTF-16, matching PDF.js strings and DOM Range character offsets.
export function sourceText(text, itemIndex) {
  text = String(text || "");
  return { text, textSpans: text.length ? [{ start: 0, end: text.length, itemIndex,
    sourceStart: 0, sourceEnd: text.length }] : [] };
}

function compact(spans) {
  const result = [];
  for (const span of spans) {
    const previous = result.at(-1);
    if (previous && previous.pageNumber === span.pageNumber && previous.itemIndex === span.itemIndex && previous.end === span.start &&
        previous.sourceEnd === span.sourceStart) {
      previous.end = span.end;
      previous.sourceEnd = span.sourceEnd;
    } else result.push({ ...span });
  }
  return result;
}

export function concatText(parts, separator = "") {
  let text = "";
  const spans = [];
  for (const [index, part] of parts.entries()) {
    if (index) text += separator;
    const offset = text.length;
    for (const span of part.textSpans || []) spans.push({ ...span,
      start: span.start + offset, end: span.end + offset });
    text += part.text || "";
  }
  return { text, textSpans: compact(spans) };
}

export function sliceText(value, start = 0, end = value.text.length) {
  const text = String(value.text || "");
  start = Math.max(0, start < 0 ? text.length + start : start);
  end = Math.min(text.length, end < 0 ? text.length + end : end);
  const spans = [];
  for (const span of value.textSpans || []) {
    const left = Math.max(start, span.start), right = Math.min(end, span.end);
    if (left >= right) continue;
    spans.push({ start: left - start, end: right - start, itemIndex: span.itemIndex,
      ...(span.pageNumber == null ? {} : { pageNumber: span.pageNumber }),
      sourceStart: span.sourceStart + left - span.start,
      sourceEnd: span.sourceStart + right - span.start });
  }
  return { text: text.slice(start, end), textSpans: compact(spans) };
}

function replaceText(value, pattern, replacement) {
  const parts = [];
  let end = 0;
  for (const match of value.text.matchAll(pattern)) {
    parts.push(sliceText(value, end, match.index));
    if (replacement) parts.push({ ...sliceText(value, match.index, match.index + replacement.length), text: replacement });
    end = match.index + match[0].length;
  }
  if (!end) return value;
  parts.push(sliceText(value, end));
  return concatText(parts);
}

export function normalizeWhitespace(value) {
  value = replaceText(value, /\s+/g, " ");
  const start = value.text.length - value.text.trimStart().length;
  return sliceText(value, start, value.text.trimEnd().length);
}

export function normalizeSentenceSource(value) {
  value = replaceText(value, /\u00ad\s*/g, "");
  value = replaceText(value, /-\s*\r?\n\s*/g, "-");
  return normalizeWhitespace(value);
}

export function getSourceRanges(value, start = 0, end = value.text.length) {
  const ranges = [];
  for (const span of sliceText(value, start, end).textSpans) {
    const previous = ranges.at(-1);
    if (previous && previous.pageNumber === span.pageNumber && previous.itemIndex === span.itemIndex && previous.end === span.sourceStart) previous.end = span.sourceEnd;
    else ranges.push({ itemIndex: span.itemIndex, start: span.sourceStart, end: span.sourceEnd,
      ...(span.pageNumber == null ? {} : { pageNumber: span.pageNumber }) });
  }
  return ranges;
}
