const median = (values, fallback) => {
  const sorted = values.filter((value) => value > 0 && Number.isFinite(value)).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : fallback;
};

// Numbering is display metadata only; unnumbered headings have no inferred depth.
export function getDisplaySections(pages) {
  const result = new Map(), colors = new Map();
  let section = { id: "preamble", rootId: "preamble", level: null, color: 0 }, previous;
  for (const page of pages) for (const unit of page.blocks || []) {
    if (result.has(unit.id)) continue;
    if (unit.kind === "heading" && !(previous?.kind === "heading" && unit.layoutRegionId &&
        unit.layoutRegionId === previous.layoutRegionId)) {
      const source = unit.text.trim();
      const number = source.match(/^(\d+(?:\.\d+)*|[A-Z](?:\.\d+)+)(?:\.(?=\s))?(?:\s+|$)/)?.[1] ||
        source.match(/^Appendix\s+([A-Z](?:\.\d+)*)\b/i)?.[1]?.toUpperCase() ||
        source.match(/^([A-Z])[.]?\s+(?=[A-Z][A-Z\s,–—-]+$)/)?.[1];
      const path = number?.split('.'), rootId = path ? `number:${path[0]}` : unit.id;
      if (!colors.has(rootId)) colors.set(rootId, colors.size);
      section = { id: unit.id, rootId, level: path?.length ?? null, color: colors.get(rootId) };
    }
    result.set(unit.id, section);
    previous = unit;
  }
  return result;
}

// Display grouping uses layout only; sentence IDs, requests and cached translations stay unchanged.
export function getDisplayParagraphs(page, items = [], viewport = {}) {
  const matrix = viewport.transform || [1, 0, 0, -1, 0, page.height || 800];
  const positioned = new Map();
  const rangesOf = (unit) => (unit.sourceRanges || []).filter((range) => range.pageNumber == null || range.pageNumber === page.pageNumber);
  for (const unit of page.blocks) {
    for (const range of rangesOf(unit)) {
      const item = items[range.itemIndex], tx = item?.transform;
      if (!tx) continue;
      const x = matrix[0] * tx[4] + matrix[2] * tx[5] + matrix[4];
      const y = matrix[1] * tx[4] + matrix[3] * tx[5] + matrix[5];
      positioned.set(range.itemIndex, { x, y, font: Math.abs(item.height) || Math.hypot(tx[2], tx[3]),
        column: page.mode === "two" ? (x < page.width / 2 ? 1 : 2) : 0 });
    }
  }
  const body = page.blocks.filter((unit) => unit.kind === "paragraph").flatMap((unit) =>
    rangesOf(unit).map((range) => positioned.get(range.itemIndex)).filter(Boolean));
  const font = median(body.map((item) => item.font), 10);
  const columns = new Map();
  for (const item of body) {
    if (!columns.has(item.column)) columns.set(item.column, []);
    columns.get(item.column).push(item);
  }
  const leftEdges = new Map(), gaps = [];
  for (const [column, values] of columns) {
    const xs = values.map((item) => item.x).sort((a, b) => a - b);
    leftEdges.set(column, xs[Math.floor(xs.length * 0.1)]);
    const ys = values.map((item) => item.y).sort((a, b) => a - b);
    const rows = ys.filter((y, i) => !i || y - ys[i - 1] > font * 0.4);
    for (let i = 1; i < rows.length; i++) {
      const gap = rows[i] - rows[i - 1];
      if (gap < font * 2.2) gaps.push(gap);
    }
  }
  const lineGap = median(gaps, font * 1.2);
  const result = new Map();
  let previous = null, group = "";
  for (const unit of page.blocks) {
    const ranges = rangesOf(unit), first = ranges[0];
    const start = first && positioned.get(first.itemIndex);
    const previousRanges = previous && rangesOf(previous);
    const last = previousRanges?.at(-1);
    const end = last && positioned.get(last.itemIndex);
    const sameSource = previous?.sourceBlockIds?.some((id) => unit.sourceBlockIds?.includes(id));
    let separate = !previous || unit.kind !== previous.kind || !sameSource;
    if (unit.kind === "paragraph" && previous?.kind === "paragraph" && page.mode !== "structured" && start && end) {
      const sameLine = start.column === end.column && Math.abs(start.y - end.y) < font * 0.5;
      const startsItem = first.start === 0 || !items[first.itemIndex].str.slice(0, first.start).trim();
      const indented = startsItem && start.x - leftEdges.get(start.column) > font * 0.7;
      const spaced = start.column === end.column && start.y - end.y > lineGap * 1.35;
      separate = !sameLine && (indented || spaced);
    }
    if (unit.layoutRegionId && previous?.layoutRegionId && unit.kind === previous.kind &&
        ["paragraph", "caption", "footnote"].includes(unit.kind)) {
      if (unit.layoutRegionId === previous.layoutRegionId) separate = false;
      else if (!start || !end || start.column === end.column) separate = true;
    }
    if (unit.kind === "heading") separate = previous?.kind !== "heading" || !unit.layoutRegionId ||
      unit.layoutRegionId !== previous.layoutRegionId;
    if (unit.kind === "formula" || unit.kind === "table") separate = true;
    if (separate) group = `p${page.pageNumber}:${unit.id}`;
    result.set(unit.id, group);
    previous = unit;
  }
  return result;
}
