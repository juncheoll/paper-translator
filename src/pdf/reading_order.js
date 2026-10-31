import { sourceText, concatText, sliceText, normalizeWhitespace } from "./text_provenance.js";
import { extractGraphicRegions, figureRegionsNearCaptions } from "./figure_regions.js";
import { assignLayoutItems, doclingPictureItems, doclingRunningMatterItems, manualRegionItems } from "./layout_guidance.js";
import { pdfFontNames, pdfFontMetrics, isMathFontName, extractInlineMathRegions } from "./inline_math.js";

// PDF drawing order is not reading order. Keep item provenance so no text is lost.
const clean = (text) => String(text || "").replace(/\s+/g, " ").trim();
const right = (box) => box.x + box.width;
const bottom = (box) => box.y + box.height;
const median = (numbers) => {
  const sorted = numbers.filter((n) => Number.isFinite(n) && n > 0).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 10;
};

function union(boxes) {
  const x = Math.min(...boxes.map((b) => b.x));
  const y = Math.min(...boxes.map((b) => b.y));
  return { x, y, width: Math.max(...boxes.map(right)) - x, height: Math.max(...boxes.map(bottom)) - y };
}

function point(matrix, x, y) {
  return { x: matrix[0] * x + matrix[2] * y + matrix[4], y: matrix[1] * x + matrix[3] * y + matrix[5] };
}

function positionedItems(items, styles, viewport, fontNames = {}) {
  const matrix = viewport.transform || [1, 0, 0, -1, 0, viewport.height];
  const stack = [];
  const result = [];
  items.forEach((item, index) => {
    if (item.str === undefined) {
      if (item.type === "beginMarkedContentProps" || item.type === "beginMarkedContent") stack.push(item.id || null);
      else if (item.type === "endMarkedContent") stack.pop();
      return;
    }
    if (!clean(item.str)) return;
    const tx = item.transform || [1, 0, 0, 1, 0, 0];
    const baseline = Math.hypot(tx[0], tx[1]) || 1;
    const vertical = Math.hypot(tx[2], tx[3]) || baseline;
    const ux = tx[0] / baseline, uy = tx[1] / baseline;
    const vx = tx[2] / vertical, vy = tx[3] / vertical;
    const height = Math.abs(item.height) || vertical;
    const width = Math.abs(item.width) || clean(item.str).length * height * 0.5;
    const style = styles[item.fontName] || {};
    const { ascent, descent } = pdfFontMetrics(style, 1, 0);
    const corners = [0, width].flatMap((length) => [descent * height, ascent * height].map((rise) =>
      point(matrix, tx[4] + ux * length + vx * rise, tx[5] + uy * length + vy * rise)));
    const box = union(corners.map((p) => ({ ...p, width: 0, height: 0 })));
    const transformedBaseline = point(matrix, tx[4] + ux, tx[5] + uy);
    const origin = point(matrix, tx[4], tx[5]);
    result.push({ index, text: item.str, box, fontName: item.fontName, fontHeight: height * Math.hypot(matrix[2], matrix[3]),
      angle: Math.atan2(transformedBaseline.y - origin.y, transformedBaseline.x - origin.x),
      monospace: /monospace|courier|mono/i.test(style.fontFamily || ""),
      math: isMathFontName(fontNames[item.fontName] || style.fontFamily),
      markedId: [...stack].reverse().find(Boolean) || null });
  });
  return result;
}

function gutterOf(items, pageWidth) {
  if (items.length < 4 || !pageWidth) return null;
  const font = median(items.map((item) => item.fontHeight));
  const candidates = items.filter((item) => item.box.width < pageWidth * 0.66 && item.box.height < font * 2.5);
  const bins = 160, projection = Array(bins).fill(0);
  const edge = (values, upper) => {
    values.sort((a, b) => a - b);
    if (values.length < 10) return values[upper ? values.length - 1 : 0];
    return values[upper ? Math.floor((values.length - 1) * 0.95) : Math.ceil((values.length - 1) * 0.05)];
  };
  for (const item of candidates) {
    const first = Math.max(0, Math.floor(item.box.x / pageWidth * bins));
    const last = Math.min(bins - 1, Math.ceil(right(item.box) / pageWidth * bins));
    for (let i = first; i <= last; i++) projection[i] += Math.max(1, item.box.height);
  }
  let best = null;
  for (let i = Math.floor(bins * 0.27); i < bins * 0.73; i++) {
    const center = (i + 0.5) / bins * pageWidth;
    const left = candidates.filter((item) => right(item.box) < center);
    const rightItems = candidates.filter((item) => item.box.x > center);
    if (left.length < 2 || rightItems.length < 2) continue;
    // Centered title/author fragments must not erase an otherwise repeated column gap.
    const leftEdge = edge(left.map((item) => right(item.box)), true);
    const rightEdge = edge(rightItems.map((item) => item.box.x), false);
    const gap = rightEdge - leftEdge;
    if (gap < Math.max(font * 1.1, pageWidth * 0.018)) continue;
    const crossing = candidates.filter((item) => item.box.x < center && right(item.box) > center).length;
    if (crossing > candidates.length * 0.14) continue;
    const score = gap / pageWidth - Math.abs(center / pageWidth - 0.5) * 0.02 - projection[i] / Math.max(1, candidates.length * font);
    if (!best || score > best.score) best = { score, x: (leftEdge + rightEdge) / 2 };
  }
  return best?.x ?? null;
}

function lineText(items) {
  let result = { text: "", textSpans: [] }, previous = null;
  for (const item of items) {
    const gap = previous ? item.box.x - right(previous.box) : 0;
    const separator = result.text && !/\s$/.test(result.text) && !/^\s|^[,.;:!?\)\]]/.test(item.text) &&
      gap > Math.min(previous.fontHeight, item.fontHeight) * 0.12 ? " " : "";
    result = concatText([result, sourceText(item.text, item.index)], separator);
    previous = item;
  }
  return normalizeWhitespace(result);
}

function captionLinesOf(items) {
  return items.filter((item) => Math.abs(Math.sin(item.angle)) < 0.2 &&
    /^(?:fig(?:ure)?\.?|table)\s*\d+[.:]/i.test(item.text.trim())).map((caption) => {
    const mid = caption.box.y + caption.box.height / 2;
    const aligned = items.filter((item) => Math.abs(Math.sin(item.angle)) < 0.2 &&
      Math.abs(item.box.y + item.box.height / 2 - mid) < Math.min(item.box.height, caption.box.height) * 0.45)
      .sort((a, b) => a.box.x - b.box.x || a.index - b.index);
    const run = [];
    for (const item of aligned.slice(aligned.indexOf(caption))) {
      const previous = run.at(-1);
      if (previous && item.box.x - right(previous.box) > caption.fontHeight * 1.2) break;
      run.push(item);
    }
    return { text: caption.text, box: union(run.map((item) => item.box)) };
  });
}

function linesOf(items, gutter, pageWidth) {
  const rows = [];
  for (const item of [...items].sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x || a.index - b.index)) {
    const mid = item.box.y + item.box.height / 2;
    let row = rows.find((candidate) =>
      Math.abs(candidate.mid - mid) <= Math.max(2, Math.min(candidate.height, item.box.height) * 0.45) ||
      Math.min(candidate.bottom, bottom(item.box)) - Math.max(candidate.top, item.box.y) > Math.min(candidate.height, item.box.height) * 0.35);
    if (!row) rows.push(row = { mid, height: item.box.height, top: item.box.y, bottom: bottom(item.box), items: [] });
    row.items.push(item);
    row.top = Math.min(row.top, item.box.y);
    row.bottom = Math.max(row.bottom, bottom(item.box));
  }
  const lines = [];
  for (const row of rows) {
    let group = [];
    const flush = () => {
      if (!group.length) return;
      const mainText = group.reduce((longest, item) => item.text.length > longest.text.length ? item : longest);
      lines.push({ items: group, box: union(group.map((item) => item.box)),
        fontName: mainText.fontName, fontHeight: median(group.map((item) => item.fontHeight)), ...lineText(group) });
      group = [];
    };
    for (const item of row.items.sort((a, b) => a.box.x - b.box.x || a.index - b.index)) {
      const previous = group[group.length - 1];
      const gap = previous ? item.box.x - right(previous.box) : 0;
      const crossesGutter = previous && gutter != null && right(previous.box) < gutter && item.box.x > gutter;
      if (previous && !(previous.monospace && item.monospace) && (crossesGutter || gap > Math.max(item.fontHeight * 2, pageWidth * 0.025))) flush();
      group.push(item);
    }
    flush();
  }
  return lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
}

function tableRowsOf(lines, font) {
  const rows = [];
  for (const line of lines) {
    let row = rows.find((candidate) => Math.abs(candidate.y - line.box.y) < font * 0.4);
    if (!row) rows.push(row = { y: line.box.y, lines: [] });
    row.lines.push(line);
  }
  const tableRows = new Set();
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1], current = rows[i];
    if (previous.lines.length < 3 || current.lines.length !== previous.lines.length || current.y - previous.y > font * 2.5) continue;
    const aligned = previous.lines.every((line, j) => Math.abs(line.box.x - current.lines[j].box.x) < font * 1.5);
    if (aligned) { tableRows.add(previous); tableRows.add(current); }
  }
  return rows.flatMap((row) => tableRows.has(row) ? [{
    items: row.lines.flatMap((line) => line.items), box: union(row.lines.map((line) => line.box)),
    fontHeight: median(row.lines.map((line) => line.fontHeight)), kind: "table",
    ...concatText(row.lines, " | "),
  }] : row.lines);
}

function kindOf(line, font, pageHeight, graphicRegions = []) {
  if (line.items.every((item) => item.monospace)) return "formula";
  const captionLabel = line.text.match(/^(?:fig(?:ure)?\.?|table)\s*[\dIVX]+(?:(\.(?!\d)|:)|(?=\s|$))/i);
  // A bare "Figure 1" also starts body references; require independent layout evidence.
  const unpunctuatedCaption = captionLabel && !captionLabel[1] && line.fontHeight < font * 0.94 &&
    graphicRegions.some((box) => {
      const overlap = Math.min(right(line.box), right(box)) - Math.max(line.box.x, box.x);
      const gap = Math.max(line.box.y - bottom(box), box.y - bottom(line.box));
      return overlap >= Math.min(line.box.width, box.width) * 0.5 && gap >= 0 && gap <= 55;
    });
  if (captionLabel?.[1] || unpunctuatedCaption) return "caption";
  if (line.box.y > pageHeight * 0.84 && line.fontHeight < font * 0.85) return "footnote";
  if (line.fontHeight > font * 1.25 || /^(?:Abstract|References|Acknowledg(?:e)?ments|Appendix(?:\s+[A-Z\d])?)$/i.test(line.text) ||
    (line.text.length < 100 && /^\d+(?:\.\d+)*\.?\s+[A-Z][A-Za-z]/.test(line.text) && !/[.!?]$/.test(line.text))) return "heading";
  if (line.text.length < 180 && /[=∑∫√±≈≠≤≥]/.test(line.text) && (line.text.match(/[a-z]{3,}/gi) || []).length <= 2) return "formula";
  return "paragraph";
}

function markFootnoteLines(lines, font, pageHeight) {
  const prose = (line) => !["formula", "table", "caption"].includes(line.kind);
  const small = (line) => line.fontHeight < font * 0.94;
  const startsNote = (line) => {
    const marker = line.items[0];
    return line.box.y > pageHeight * 0.75 && prose(line) && small(line) &&
      /^(?:\d{1,2}|[*†‡])$/.test(clean(marker?.text)) && marker.fontHeight < line.fontHeight * 0.8;
  };
  for (const seed of lines.filter(startsNote)) {
    let previous = seed;
    seed.kind = "footnote";
    for (const line of lines) {
      if (line.box.y <= previous.box.y) continue;
      const overlap = Math.min(right(previous.box), right(line.box)) - Math.max(previous.box.x, line.box.x);
      if (overlap < Math.min(previous.box.width, line.box.width) * 0.6) continue;
      const gap = line.box.y - bottom(previous.box);
      if (!prose(line) || !small(line) || gap > font * 1.4 || gap < -font * 0.2 ||
          Math.abs(line.fontHeight - previous.fontHeight) > font * 0.12) break;
      line.kind = "footnote";
      previous = line;
    }
  }
}

function joinLines(previous, next) {
  if (/\u00ad$/.test(previous.text)) return concatText([sliceText(previous, 0, -1), next]);
  // Keep ambiguous hard hyphens, rather than corrupting compound terms.
  return concatText([previous, next], /-$/.test(previous.text) ? "" : " ");
}

function blocksOf(lines, column, font, pageHeight) {
  const blocks = [];
  for (const line of lines) {
    const kind = line.kind || kindOf(line, font, pageHeight);
    const previous = blocks[blocks.length - 1];
    const gap = previous ? line.box.y - bottom(previous.bbox) : Infinity;
    const fontRatio = previous ? Math.abs(line.fontHeight - previous.fontHeight) / Math.max(1, previous.fontHeight) : Infinity;
    const aligned = previous && Math.abs(line.box.x - previous.lastX) <= font * 2.5;
    const captionContinuation = previous?.kind === "caption" && kind === "paragraph" && fontRatio < 0.06;
    const sameRegion = previous?.layoutRegionId === line.layoutRegionId;
    if (previous && sameRegion && (previous.kind === kind || captionContinuation) && kind !== "formula" && gap >= -font * 0.5 && gap <= font * 0.8 && fontRatio < 0.2 && aligned) {
      Object.assign(previous, kind === "table" ? concatText([previous, line], "\n") : joinLines(previous, line));
      previous.bbox = union([previous.bbox, line.box]);
      previous.sourceIndices.push(...line.items.map((item) => item.index));
      previous.lastX = line.box.x;
    } else blocks.push({ text: line.text, textSpans: line.textSpans, bbox: line.box, kind, column,
      ...(line.layoutRegionId ? { layoutRegionId: line.layoutRegionId } : {}),
      ...(line.layoutManual ? { layoutManual: true } : {}),
      ...(line.visualRegion ? { visualRegion: line.visualRegion } : {}),
      fontHeight: line.fontHeight, lastX: line.box.x, sourceIndices: line.items.map((item) => item.index) });
  }
  return blocks;
}

function structuredBlocks(tree, items) {
  if (!tree) return null;
  const byId = new Map();
  for (const item of items) {
    if (!item.markedId) return null;
    if (!byId.has(item.markedId)) byId.set(item.markedId, []);
    byId.get(item.markedId).push(item);
  }
  const groups = new Map(), seen = new Set();
  let duplicate = false;
  let blockNumber = 0;
  const walk = (node, group = null, role = "paragraph") => {
    if (!node) return;
    const nextRole = /^H\d?$/.test(node.role) ? "heading" :
      ({ Caption: "caption", Formula: "formula", Table: "table", Note: "footnote", P: "paragraph", LBody: "paragraph" })[node.role];
    if (nextRole && role !== "table") { role = nextRole; group = ++blockNumber; }
    if (node.type === "content") {
      const mapped = byId.get(node.id);
      if (mapped?.length) {
        const key = group ?? ++blockNumber;
        if (!groups.has(key)) groups.set(key, { items: [], kind: role });
        for (const item of mapped) {
          if (seen.has(item.index)) { duplicate = true; continue; }
          groups.get(key).items.push(item); seen.add(item.index);
        }
      }
    }
    for (const child of node.children || []) walk(child, group, role);
  };
  walk(tree);
  if (duplicate || seen.size !== items.length) return null;
  return [...groups.values()].filter((group) => group.items.length).map(({ items: group, kind }) => ({
    ...normalizeWhitespace(concatText(group.map((item) => sourceText(item.text, item.index)), " ")),
    bbox: union(group.map((item) => item.box)), kind, column: 0,
    sourceIndices: group.map((item) => item.index),
  }));
}

export function orderTextItems(rawItems, styles = {}, viewport, options = {}) {
  const { mode = "auto", pageNumber = 1, structTree = null } = options;
  const positioned = positionedItems(rawItems, styles, viewport, options.fontNames);
  const manualItems = manualRegionItems(positioned, options.layout, viewport);
  const layoutPictures = doclingPictureItems(positioned, options.layout, viewport);
  const runningMatter = doclingRunningMatterItems(positioned, options.layout, viewport);
  const figureRegions = figureRegionsNearCaptions(captionLinesOf(positioned), options.graphicRegions || []);
  const excludedFigureIndices = [], excludedRegionIndices = [];
  const items = positioned.filter((item) => {
    const manual = manualItems.get(item.index);
    if (manual) {
      if (manual.excluded || ["picture", "page_header", "page_footer"].includes(manual.label)) {
        excludedRegionIndices.push(item.index); return false;
      }
      return true;
    }
    // Tall or rotated margin stamps must not participate in line, column or paragraph geometry.
    if (runningMatter.has(item.index)) {
      excludedRegionIndices.push(item.index); return false;
    }
    const inside = figureRegions.some((box) =>
      Math.min(right(item.box), right(box)) - Math.max(item.box.x, box.x) >= item.box.width * 0.85 &&
      Math.min(bottom(item.box), bottom(box)) - Math.max(item.box.y, box.y) >= item.box.height * 0.8);
    if ((inside || layoutPictures.has(item.index)) && !/^(?:fig(?:ure)?\.?|table)\s*\d+[.:]/i.test(item.text.trim())) {
      excludedFigureIndices.push(item.index); return false;
    }
    return true;
  });
  const warnings = [];
  const visualRegions = Math.abs((options.layout?.width || 0) - viewport.width) <= 1 &&
    Math.abs((options.layout?.height || 0) - viewport.height) <= 1 ? options.layout.regions.filter((r) =>
      !r.excluded && ["formula", "table"].includes(r.label) && (r.manual || r.confidence >= .6)) : [];
  const guided = assignLayoutItems(items, options.layout, viewport) ||
    (!items.length && visualRegions.length ? { groups: [], unassigned: [] } : null);
  const finish = (blocks, detectedMode) => {
    const grouped = [];
    for (const block of blocks) {
      const previous = grouped.at(-1);
      if (block.layoutRegionId && previous?.layoutRegionId === block.layoutRegionId &&
          previous.kind === block.kind && previous.column === block.column && ["paragraph", "caption", "footnote"].includes(block.kind)) {
        Object.assign(previous, joinLines(previous, block));
        previous.bbox = union([previous.bbox, block.bbox]);
        previous.sourceIndices.push(...block.sourceIndices);
      } else grouped.push(block);
    }
    return {
      pageNumber, width: viewport.width, height: viewport.height, mode: detectedMode, warnings, excludedFigureIndices,
      ...(excludedRegionIndices.length ? { excludedRegionIndices } : {}),
      ...(grouped.some((block) => block.layoutRegionId) ? { layoutSource: "docling" } : {}),
      blocks: grouped.map(({ fontHeight, lastX, ...block }, i) => ({ ...block, id: `p${pageNumber}-b${i + 1}` })),
    };
  };
  if (!items.length && !visualRegions.length) { warnings.push("No selectable text found; OCR may be required."); return finish([], "single"); }
  if (mode === "auto" && !guided) {
    const structured = structuredBlocks(structTree, items);
    if (structured) return finish(structured, "structured");
    if (structTree) warnings.push("Incomplete PDF structure tags; used geometric reading order.");
  }
  if (items.some((item) => Math.abs(Math.sin(item.angle)) > 0.2)) warnings.push("Rotated text may require manual reading-order selection.");
  const font = median(items.flatMap((item) => Array(Math.min(20, Math.max(1, Math.ceil(clean(item.text).length / 10)))).fill(item.fontHeight)));
  const globalGutter = mode === "single" ? null : gutterOf(items, viewport.width);
  const gutter = mode === "two" ? globalGutter ?? viewport.width / 2 : globalGutter;
  // Parse inside Docling's regions/cells first; only unmatched text uses native line heuristics.
  let lines;
  if (guided) {
    lines = linesOf(guided.unassigned, gutter, viewport.width);
    const visualGroups = new Map();
    const mathTextIds = new Set(guided.groups.filter(group => !["formula", "table"].includes(group.layoutKind) &&
      group.items.some(item => item.math)).map(group => group.layoutRegionId));
    const mathTextGroups = new Map();
    for (const group of guided.groups) {
      if (["formula", "table"].includes(group.layoutLabel)) {
        if (!visualGroups.has(group.layoutRegionId)) visualGroups.set(group.layoutRegionId, { ...group, items: [] });
        visualGroups.get(group.layoutRegionId).items.push(...group.items);
        continue;
      }
      if (mathTextIds.has(group.layoutRegionId)) {
        if (!mathTextGroups.has(group.layoutRegionId)) mathTextGroups.set(group.layoutRegionId, { ...group, items: [] });
        mathTextGroups.get(group.layoutRegionId).items.push(...group.items);
        continue;
      }
      const members = group.items.sort((a, b) => a.box.x - b.box.x || a.index - b.index);
      const main = members.reduce((a, b) => a.text.length >= b.text.length ? a : b);
      const rows = group.cell ? [{ items: members, box: union(members.map((item) => item.box)),
        fontName: main.fontName, fontHeight: median(members.map((item) => item.fontHeight)), ...lineText(members) }]
        : linesOf(members, gutter, viewport.width);
      lines.push(...rows.map((line) => ({ ...line, layoutRegionId: group.layoutRegionId, layoutKind: group.layoutKind,
        layoutManual: group.layoutManual })));
    }
    // Accent fonts can split one text line into several detected cells. Rejoin that region by geometry.
    for (const group of mathTextGroups.values()) lines.push(...linesOf(group.items, gutter, viewport.width).map(line => ({
      ...line, layoutRegionId: group.layoutRegionId, layoutKind: group.layoutKind, layoutManual: group.layoutManual,
    })));
    // Keep a formula/table whole, even when Docling supplies a cell for every text fragment.
    for (const region of visualRegions) {
      const id = `d${pageNumber}-${region.id}`;
      const group = visualGroups.get(id), members = (group?.items || []).sort((a, b) => a.index - b.index);
      lines.push({ items: members, ...lineText(members), box: region.bbox, fontName: members[0]?.fontName || "",
        fontHeight: font, kind: region.label, layoutKind: region.label, layoutRegionId: id, layoutManual: !!region.manual,
        visualRegion: { bbox: region.bbox, pageNumber, width: viewport.width, height: viewport.height } });
    }
    lines.sort((a, b) => a.box.y - b.box.y || a.box.x - b.box.x);
  } else lines = tableRowsOf(linesOf(items, gutter, viewport.width), font);
  if (items.some((item) => item.monospace)) warnings.push("Monospaced listings are kept as source blocks.");
  if (lines.some((line) => line.kind === "table" || /^Table\s*[\dIVX]+/i.test(line.text))) warnings.push("Check table row and column order; complex tables may need source-only display.");
  for (const line of lines) line.kind ||= kindOf(line, font, viewport.height, options.graphicRegions);
  // Counts at a wrapped line start are prose when the preceding body line continues in the same font.
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.kind !== "heading" || line.fontHeight > font * 1.1 || !/^\d+(?:\.\d+)*\.?\s+[A-Z][A-Za-z]/.test(line.text)) continue;
    const previous = lines.slice(0, i).reverse().find((other) => other.box.y < line.box.y &&
      Math.abs(other.box.x - line.box.x) < font * 2.5 &&
      Math.min(right(other.box), right(line.box)) - Math.max(other.box.x, line.box.x) >= Math.min(other.box.width, line.box.width) * 0.6);
    if (!previous || previous.kind !== "paragraph" || previous.fontName !== line.fontName ||
        Math.abs(previous.fontHeight - line.fontHeight) > font * 0.06) continue;
    const gap = line.box.y - bottom(previous.box);
    if (gap >= -font * 0.5 && gap <= font * 0.8 &&
        !/[.!?。！？][\])}"'”’»」』】]*(?:\s*\[[\d,;\s–-]+\])*$/.test(previous.text)) line.kind = "paragraph";
  }
  markFootnoteLines(lines, font, viewport.height);
  if (guided) {
    const captionRegions = new Set(lines.filter((line) => line.kind === "caption").map((line) => line.layoutRegionId));
    for (const line of lines) {
      if (line.layoutManual && line.layoutKind) { line.kind = line.layoutKind; continue; }
      // Keep the existing figure/footnote exclusions and require a real caption seed.
      if (line.kind === "footnote" || line.kind === "caption" && line.layoutKind !== "caption" || !line.layoutKind ||
          line.layoutKind === "caption" && !captionRegions.has(line.layoutRegionId)) continue;
      line.kind = line.layoutKind;
    }
  }
  const footnotes = lines.filter((line) => line.kind === "footnote");
  const bodyLines = [];
  for (const line of lines.filter((line) => line.kind !== "footnote")) {
    const previous = bodyLines.at(-1);
    const gap = previous ? line.box.y - bottom(previous.box) : Infinity;
    // Consolidate full-width captions before their individual lines become column barriers.
    if (previous?.kind === "caption" && previous.layoutRegionId === line.layoutRegionId &&
        previous.box.width > viewport.width * 0.55 &&
        (line.kind === "paragraph" || previous.layoutRegionId && line.kind === "caption") &&
        gap >= -font * 0.5 && gap <= previous.fontHeight * 0.8 &&
        Math.abs(previous.fontHeight - line.fontHeight) < previous.fontHeight * 0.06 &&
        Math.abs(previous.box.x - line.box.x) < font * 2.5) {
      Object.assign(previous, joinLines(previous, line));
      previous.box = union([previous.box, line.box]);
      previous.items.push(...line.items);
    } else bodyLines.push(line);
  }
  const barrierX = gutter ?? viewport.width / 2;
  const spanning = mode === "single" ? [] : bodyLines.filter((line) =>
    line.box.x < barrierX && right(line.box) > barrierX &&
    (line.box.width > viewport.width * 0.55 || line.fontHeight > font * 1.35));
  const spanSet = new Set(spanning);
  const remaining = bodyLines.filter((line) => !spanSet.has(line));
  const output = [];
  let hasTwo = false;
  const addBand = (band) => {
    if (!band.length) return;
    const local = mode === "single" ? null : gutterOf(band.map((line) => ({ box: line.box, fontHeight: line.fontHeight })), viewport.width);
    const split = mode === "two" ? local ?? gutter : local;
    if (split != null) {
      hasTwo = true;
      const left = band.filter((line) => line.box.x + line.box.width / 2 < split);
      const rightLines = band.filter((line) => line.box.x + line.box.width / 2 >= split);
      output.push(...blocksOf(left, 1, font, viewport.height), ...blocksOf(rightLines, 2, font, viewport.height));
    } else output.push(...blocksOf(band, 0, font, viewport.height));
  };
  for (const wide of spanning) {
    const above = remaining.filter((line) => line.box.y + line.box.height / 2 < wide.box.y + wide.box.height / 2);
    const selected = new Set(above);
    addBand(above);
    for (let i = remaining.length - 1; i >= 0; i--) if (selected.has(remaining[i])) remaining.splice(i, 1);
    const block = blocksOf([wide], 0, font, viewport.height)[0];
    const previous = output[output.length - 1];
    const gap = previous ? block.bbox.y - bottom(previous.bbox) : Infinity;
    const center = (box) => box.x + box.width / 2;
    const headingContinuation = !above.length && previous?.kind === "heading" && block.kind === "heading" &&
      previous.column === 0 && gap >= 0 && gap <= block.fontHeight * 0.8 &&
      Math.abs(previous.fontHeight - block.fontHeight) < block.fontHeight * 0.1 &&
      Math.abs(center(previous.bbox) - center(block.bbox)) < block.fontHeight &&
      Math.abs(center(block.bbox) - viewport.width / 2) < block.fontHeight * 2 &&
      !/^\d+(?:\.\d+)*\.?\s/.test(block.text);
    if (headingContinuation) {
      Object.assign(previous, joinLines(previous, block));
      previous.bbox = union([previous.bbox, block.bbox]);
      previous.sourceIndices.push(...block.sourceIndices);
    } else output.push(block);
  }
  addBand(remaining);
  addBand(footnotes);
  if (!hasTwo && mode === "auto" && globalGutter != null) warnings.push("Column boundaries vary; check the reading-order preview.");
  return finish(output, hasTwo ? "two" : "single");
}

export async function extractOrderedPage(pdfPage, { mode = "auto", layout } = {}) {
  const viewport = pdfPage.getViewport({ scale: 1 });
  const [content, tree, operators] = await Promise.all([
    pdfPage.getTextContent({ includeMarkedContent: true, disableNormalization: true }),
    mode === "auto" && pdfPage.getStructTree ? pdfPage.getStructTree().catch(() => null) : null,
    pdfPage.getOperatorList ? pdfPage.getOperatorList().catch(() => null) : null,
  ]);
  const fontNames = pdfFontNames(pdfPage, content.styles);
  const result = orderTextItems(content.items, content.styles, viewport, { mode, layout, fontNames, pageNumber: pdfPage.pageNumber, structTree: tree,
    graphicRegions: extractGraphicRegions(operators, viewport, globalThis.pdfjsLib?.OPS) });
  const math = extractInlineMathRegions(content.items, content.styles, viewport, result.blocks, fontNames, pdfPage.pageNumber);
  return math.length ? { ...result, inlineMathRegions: math } : result;
}
