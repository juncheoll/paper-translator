import { getDisplayParagraphs, getDisplaySections } from "../src/pdf/display_paragraphs";

const item = (str, x, y) => ({ str, height: 10, transform: [10, 0, 0, 10, x, 800 - y] });
const unit = (id, index, extra = {}) => ({ id, kind: "paragraph", text: id, sourceBlockIds: ["source"],
  sourceRanges: [{ itemIndex: index, start: 0, end: 4 }], ...extra });
const page = (blocks, mode = "single") => ({ pageNumber: 1, width: 600, height: 800, mode, blocks });

test("indentation and extra line spacing recover visual paragraphs without changing sentence units", () => {
  const items = [item("First.", 40, 100), item("Second.", 40, 112), item("Third.", 54, 124),
    item("Fourth.", 40, 136), item("Fifth.", 40, 160)];
  const input = page(items.map((_, i) => unit(`s${i}`, i)));
  const snapshot = structuredClone(input);
  const result = getDisplayParagraphs(input, items);
  expect(result.get("s0")).toBe(result.get("s1"));
  expect(result.get("s2")).toBe(result.get("s3"));
  expect(new Set(result.values()).size).toBe(3);
  expect(input).toEqual(snapshot);
});

test("sentences within one line stay in one paragraph and column flow does not itself create a paragraph", () => {
  const items = [item("First. Next.", 40, 600), item("Continued.", 330, 100), item("Indented.", 344, 112)];
  const input = page([unit("first", 0), unit("same-line", 0, { sourceRanges: [{ itemIndex: 0, start: 7, end: 12 }] }),
    unit("right", 1, { sourceBlockIds: ["right"] }), unit("new", 2, { sourceBlockIds: ["right"] })], "two");
  const result = getDisplayParagraphs(input, items);
  expect(result.get("first")).toBe(result.get("same-line"));
  expect(result.get("first")).toBe(result.get("right"));
  expect(result.get("new")).not.toBe(result.get("right"));
});

test("semantic paragraph tags and structural headings are respected even with identical coordinates", () => {
  const items = [item("First.", 40, 100), item("Second.", 40, 112)];
  const semantic = page([unit("a", 0), unit("b", 1, { sourceBlockIds: ["other"] })], "structured");
  const result = getDisplayParagraphs(semantic, items);
  expect(result.get("a")).not.toBe(result.get("b"));
  const structural = getDisplayParagraphs(page([unit("a", 0), unit("heading", 0, { kind: "heading" }), unit("b", 1)]), items);
  expect(new Set(structural.values()).size).toBe(3);
});

test("shared sentences use only the layout of the visible page and fallback grouping follows source paragraphs", () => {
  const shared = unit("shared", 0, { sourceRanges: [{ pageNumber: 1, itemIndex: 9, start: 0, end: 5 },
    { pageNumber: 2, itemIndex: 0, start: 0, end: 4 }] });
  const input = { ...page([shared, unit("next", 1)]), pageNumber: 2 };
  expect(getDisplayParagraphs(input, [item("Continues.", 40, 100), item("Next.", 40, 112)]).get("shared"))
    .toBe(getDisplayParagraphs(input, [item("Continues.", 40, 100), item("Next.", 40, 112)]).get("next"));
  const fallback = getDisplayParagraphs(page([unit("a", 0), unit("b", 1), unit("c", 2, { sourceBlockIds: ["new"] })]));
  expect(fallback.get("a")).toBe(fallback.get("b"));
  expect(fallback.get("c")).not.toBe(fallback.get("b"));
});

test("Docling regions define same-column display paragraphs without breaking continued column flow", () => {
  const items = [item("First.", 40, 100), item("Second.", 54, 112), item("Third.", 40, 124), item("Continued.", 330, 100)];
  const input = page([unit("a", 0, { layoutRegionId: "r1" }), unit("b", 1, { layoutRegionId: "r1" }),
    unit("c", 2, { layoutRegionId: "r2" }), unit("d", 3, { layoutRegionId: "r3" })], "two");
  const result = getDisplayParagraphs(input, items);
  expect(result.get("a")).toBe(result.get("b"));
  expect(result.get("b")).not.toBe(result.get("c"));
  expect(result.get("c")).toBe(result.get("d"));
});

test("numbered section depth and root colors survive page boundaries without changing source units", () => {
  const heading = (id, text, extra = {}) => unit(id, 0, { kind: 'heading', text, ...extra });
  const shared = unit('continued', 0);
  const pages = [page([heading('intro', '1 INTRODUCTION'), unit('intro-text', 0),
    heading('sub', '1.2 Model'), heading('deep', '1.2.3. Details'), shared]),
    { ...page([shared, unit('continued-next', 0), heading('method', '2. Method'), unit('method-text', 0)]), pageNumber: 2 }];
  const before = structuredClone(pages), sections = getDisplaySections(pages);
  expect(sections.get('intro').level).toBe(1); expect(sections.get('sub').level).toBe(2);
  expect(sections.get('deep').level).toBe(3);
  expect(sections.get('intro').color).toBe(sections.get('sub').color);
  expect(sections.get('continued-next')).toEqual(sections.get('deep'));
  expect(sections.get('method-text').color).not.toBe(sections.get('intro-text').color);
  expect(pages).toEqual(before);
});

test("appendices have explicit depth and unnumbered or non-heading numbered text does not acquire a depth", () => {
  const headings = ['ABSTRACT', 'A SELECTION THEORY', 'A.1 Proofs', 'A.1.2 Details', 'Appendix B', 'Overview', 'Appendix B.2 Proof'];
  const blocks = headings.map((text, i) => unit(`h${i}`, i, { text, kind: 'heading' }));
  blocks.push(unit('body-number', 6, { text: '1.2 is a coefficient.' }));
  const result = getDisplaySections([page(blocks)]);
  expect(result.get('h0').level).toBeNull(); expect(result.get('h5').level).toBeNull();
  expect(result.get('h1').level).toBe(1); expect(result.get('h2').level).toBe(2); expect(result.get('h3').level).toBe(3);
  expect(result.get('h1').rootId).toBe(result.get('h3').rootId);
  expect(result.get('h4').level).toBe(1); expect(result.get('h6').level).toBe(2);
  expect(result.get('body-number')).toEqual(result.get('h6'));
});

test("multiline headings within one Docling region share one heading box and section", () => {
  const blocks = [unit('title-a', 0, { kind: 'heading', text: '3.1 Long heading', layoutRegionId: 'd1-3' }),
    unit('title-b', 1, { kind: 'heading', text: 'CONTINUED TITLE', layoutRegionId: 'd1-3' }), unit('body', 2)];
  const input = page(blocks), paragraphs = getDisplayParagraphs(input), sections = getDisplaySections([input]);
  expect(paragraphs.get('title-a')).toBe(paragraphs.get('title-b'));
  expect(sections.get('title-b')).toEqual(sections.get('title-a'));
  expect(sections.get('body').level).toBe(2);
});
