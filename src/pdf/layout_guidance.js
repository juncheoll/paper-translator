const kinds = { text: "paragraph", list_item: "paragraph", section_header: "heading", title: "heading",
  caption: "caption", footnote: "footnote", table: "table", formula: "formula", code: "formula" };
const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
const compatible = (layout, viewport) => layout?.regions?.length &&
  Math.abs(layout.width - viewport.width) <= 1 && Math.abs(layout.height - viewport.height) <= 1;

export function manualRegionItems(items, layout, viewport) {
  const result = new Map();
  if (!compatible(layout, viewport)) return result;
  for (const item of items) {
    const area = item.box.width * item.box.height;
    let selected, score = .55;
    for (const region of layout.regions.filter((r) => r.manual)) {
      const value = area > 0 ? overlap(item.box, region.bbox) / area : 0;
      if (value > score || value === score && region.excluded) { selected = region; score = value; }
    }
    if (selected) result.set(item.index, selected);
  }
  return result;
}

export function doclingPictureItems(items, layout, viewport) {
  if (!compatible(layout, viewport)) return new Set();
  const pictures = layout.regions.filter((r) => r.label === "picture" && r.confidence >= 0.75);
  const text = layout.regions.filter((r) => kinds[r.label] && r.confidence >= 0.6);
  return new Set(items.filter((item) => {
    const area = item.box.width * item.box.height;
    return area > 0 && pictures.some((r) => overlap(item.box, r.bbox) / area >= 0.85) &&
      !text.some((r) => overlap(item.box, r.bbox) / area >= 0.55);
  }).map((item) => item.index));
}

export function doclingRunningMatterItems(items, layout, viewport) {
  if (!compatible(layout, viewport)) return new Set();
  const regions = layout.regions.filter((r) => ["page_header", "page_footer"].includes(r.label) && r.confidence >= 0.6);
  return new Set(items.filter((item) => {
    const area = item.box.width * item.box.height;
    return area > 0 && regions.some((r) => overlap(item.box, r.bbox) / area >= 0.55);
  }).map((item) => item.index));
}

// Geometry only: every surviving PDF.js item belongs to exactly one group or remains on the native path.
export function assignLayoutItems(items, layout, viewport) {
  if (!compatible(layout, viewport)) return null;
  const regions = layout.regions.filter((r) => (kinds[r.label] || r.manual) && !r.excluded && (r.manual || r.confidence >= 0.6));
  const groups = new Map(), unassigned = [];
  let assignedChars = 0, totalChars = 0;
  for (const item of items) {
    totalChars += item.text.length;
    const area = item.box.width * item.box.height;
    let best, score = 0.55;
    if (area > 0 && Math.abs(Math.sin(item.angle)) < 0.2) {
      for (const region of regions) {
        const coverage = overlap(item.box, region.bbox) / area;
        const value = coverage + region.confidence * 0.001 + (region.manual ? 2 : 0);
        if (coverage >= 0.55 && value > score) { best = region; score = value; }
      }
    }
    if (!best) { unassigned.push(item); continue; }
    let cellIndex = -1, cellScore = 0.55;
    for (const [i, cell] of best.cells.entries()) {
      const value = overlap(item.box, cell) / area;
      if (value > cellScore) { cellIndex = i; cellScore = value; }
    }
    const key = `${best.id}:${cellIndex}`;
    if (!groups.has(key)) groups.set(key, { items: [], cell: cellIndex >= 0,
      layoutRegionId: `d${layout.pageNumber}-${best.id}`, layoutKind: kinds[best.label] || "paragraph",
      layoutBBox: best.bbox, layoutLabel: best.label, layoutManual: !!best.manual });
    groups.get(key).items.push(item);
    assignedChars += item.text.length;
  }
  // Wrong coordinates or a substantially incomplete detection must not replace a good native reading order.
  if (!totalChars || assignedChars / totalChars < 0.85 && !regions.some((r) => r.manual)) return null;
  return { groups: [...groups.values()], unassigned };
}
