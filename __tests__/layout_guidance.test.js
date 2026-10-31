import { orderTextItems } from "../src/pdf/reading_order";
import { createSentenceUnits } from "../src/pdf/sentences";
import { filterDocumentBody } from "../src/pdf/document_body";

const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
const styles = { body: { ascent: 1, descent: 0 } };
const item = (str, x, y, width = 200, height = 10) => ({ str, width, height, fontName: "body",
  transform: [height, 0, 0, height, x, 800 - y - height] });
const region = (id, label, x, y, width, height, cells = []) => ({ id, label, confidence: 0.95,
  bbox: { x, y, width, height }, cells });
const layout = (regions) => ({ pageNumber: 1, width: 600, height: 800, regions });
const cell = (x, y, width = 200) => ({ x, y, width, height: 10 });

test("Docling cells restore line order and retain exact native item offsets", () => {
  const items = [item("Second line.", 40, 112), item("First", 40, 100, 30), item("line.", 75, 100, 30)];
  const page = orderTextItems(items, styles, viewport, { layout: layout([
    region(1, "text", 40, 100, 200, 22, [cell(40, 100), cell(40, 112)]),
  ]) });
  expect(page.layoutSource).toBe("docling");
  expect(page.blocks).toHaveLength(1);
  expect(page.blocks[0].text).toBe("First line. Second line.");
  const units = createSentenceUnits(page);
  expect(units.map((x) => x.text)).toEqual(["First line.", "Second line."]);
  expect(units[0].sourceRanges).toEqual([{ itemIndex: 1, start: 0, end: 5 }, { itemIndex: 2, start: 0, end: 5 }]);
  expect(units[1].sourceRanges).toEqual([{ itemIndex: 0, start: 0, end: 12 }]);
});

test("region boundaries separate close paragraphs; unmatched native text remains present", () => {
  const items = [item("First paragraph.", 40, 100), item("Second paragraph.", 40, 112), item("x", 40, 200, 8)];
  const page = orderTextItems(items, styles, viewport, { layout: layout([
    region(1, "text", 40, 100, 200, 10, [cell(40, 100)]),
    region(2, "text", 40, 112, 200, 10, [cell(40, 112)]),
  ]) });
  expect(page.blocks.map((x) => x.text)).toEqual(["First paragraph.", "Second paragraph.", "x"]);
  expect(page.blocks.flatMap((x) => x.sourceIndices).sort()).toEqual([0, 1, 2]);
});

test("existing graphic exclusion vetoes a model's spurious caption inside a figure", () => {
  const items = [item("(b) Layer 51", 40, 160), item("Figure 1. Caption.", 40, 195), item("Normal body.", 40, 240)];
  const page = orderTextItems(items, styles, viewport, { graphicRegions: [{ x: 30, y: 100, width: 230, height: 90 }],
    layout: layout([region(1, "caption", 40, 160, 200, 10, [cell(40, 160)]),
      region(2, "caption", 40, 195, 200, 10, [cell(40, 195)]), region(3, "text", 40, 240, 200, 10, [cell(40, 240)])]) });
  expect(page.excludedFigureIndices).toEqual([0]);
  expect(page.blocks.map((b) => b.text)).toEqual(["Figure 1. Caption.", "Normal body."]);
});

test("Docling picture regions exclude chart text without touching overlapping caption/text detections", () => {
  const items = [item("Axis ticks", 40, 100), item("Body is protected.", 40, 200)];
  const page = orderTextItems(items, styles, viewport, { layout: layout([
    region(1, "picture", 30, 90, 230, 130), region(2, "text", 40, 200, 200, 10, [cell(40, 200)]),
  ]) });
  expect(page.excludedFigureIndices).toEqual([0]);
  expect(page.blocks[0].text).toBe("Body is protected.");
});

test("a rotated arXiv page header cannot enter a wrapped sentence or split its paragraph", () => {
  const stamp = { str: "arXiv:2610.03203v1 [cs.DC] 2 Oct 2026", width: 650, height: 10, fontName: "body",
    transform: [0, 10, -10, 0, 25, 80] };
  const items = [item("The body sentence continues", 40, 100), stamp,
    item("across these wrapped lines.", 40, 112)];
  const page = orderTextItems(items, styles, viewport, { layout: layout([
    region(1, "page_header", 15, 70, 10, 650),
    region(2, "text", 40, 100, 200, 22, [cell(40, 100), cell(40, 112)]),
  ]) });
  expect(page.excludedRegionIndices).toEqual([1]);
  expect(page.layoutSource).toBe("docling");
  expect(page.blocks.map((block) => block.text)).toEqual(["The body sentence continues across these wrapped lines."]);
  expect(page.blocks[0].sourceIndices).toEqual([0, 2]);
  expect(page.warnings).not.toContain("Rotated text may require manual reading-order selection.");
  const units = createSentenceUnits(page);
  expect(units).toHaveLength(1);
  expect(units[0].sourceRanges).toEqual([
    { itemIndex: 0, start: 0, end: items[0].str.length },
    { itemIndex: 2, start: 0, end: items[2].str.length },
  ]);
});

test("a tall page-header stamp cannot disturb two-column reading order", () => {
  const items = [item("Left paragraph starts", 40, 100, 220),
    { str: "arXiv:2610.03203v1 [cs.DC] 2 Oct 2026", width: 650, height: 10, fontName: "body",
      transform: [0, 10, -10, 0, 25, 80] },
    item("Right paragraph starts", 330, 100, 220), item("and ends here.", 40, 112, 220),
    item("and ends here too.", 330, 112, 220)];
  const page = orderTextItems(items, styles, viewport, { layout: layout([
    region(1, "page_header", 15, 70, 10, 650),
    region(2, "text", 40, 100, 220, 22, [cell(40, 100, 220), cell(40, 112, 220)]),
    region(3, "text", 330, 100, 220, 22, [cell(330, 100, 220), cell(330, 112, 220)]),
  ]) });
  expect(page.mode).toBe("two");
  expect(page.blocks.map((block) => [block.column, block.text])).toEqual([
    [1, "Left paragraph starts and ends here."], [2, "Right paragraph starts and ends here too."],
  ]);
  expect(page.blocks.flatMap((block) => block.sourceIndices)).toEqual([0, 3, 2, 4]);
  expect(page.excludedRegionIndices).toEqual([1]);
});

test("automatic page headers and footers are excluded even when body layout falls back to native parsing", () => {
  const items = [item("Running title", 40, 20), item("A body sentence spans", 40, 100),
    item("two native text lines.", 40, 112), item("42", 280, 770, 20)];
  const page = orderTextItems(items, styles, viewport, { layout: layout([
    region(1, "page_header", 40, 20, 200, 10), region(2, "page_footer", 280, 770, 20, 10),
  ]) });
  expect(page.excludedRegionIndices).toEqual([0, 3]);
  expect(page.blocks.map((block) => block.text)).toEqual(["A body sentence spans two native text lines."]);
  expect(createSentenceUnits(page)[0].sourceRanges.map((range) => range.itemIndex)).toEqual([1, 2]);
});

test("excluding running headers and footers preserves explanatory footnotes", () => {
  const items = [item("Running title", 40, 20), item("A body sentence.", 40, 100),
    item("1 We use a fixed random seed in all experiments.", 40, 700, 200, 8), item("42", 280, 770, 20)];
  const page = orderTextItems(items, styles, viewport, { layout: layout([
    region(1, "page_header", 40, 20, 200, 10), region(2, "text", 40, 100, 200, 10),
    region(3, "footnote", 40, 700, 200, 8), region(4, "page_footer", 280, 770, 20, 10),
  ]) });
  expect(page.excludedRegionIndices).toEqual([0, 3]);
  expect(filterDocumentBody([page])[0].blocks.map((block) => [block.kind, block.text])).toEqual([
    ["paragraph", items[1].str], ["footnote", items[2].str],
  ]);
});

test("low-confidence, mismatched, or incidental page-header overlap cannot remove native body text", () => {
  const items = [item("A body sentence remains intact.", 40, 100)];
  const native = orderTextItems(items, styles, viewport);
  const lowConfidence = { ...region(1, "page_header", 40, 100, 200, 10), confidence: .59 };
  const mismatched = { ...layout([region(1, "page_header", 40, 100, 200, 10)]), width: 1200 };
  const incidental = layout([region(1, "page_header", 40, 100, 20, 10)]);
  for (const detections of [layout([lowConfidence]), mismatched, incidental]) {
    expect(orderTextItems(items, styles, viewport, { layout: detections })).toEqual(native);
  }
});

test("manual body corrections override automatic headers while manually classified headers stay excluded", () => {
  const items = [item("Recovered body sentence.", 40, 100), item("Exclude this running title.", 40, 140)];
  const page = orderTextItems(items, styles, viewport, { layout: layout([
    region(1, "page_header", 40, 100, 200, 50),
    { ...region(2, "text", 40, 100, 200, 10), manual: true, confidence: .1 },
    { ...region(3, "page_header", 40, 140, 200, 10), manual: true, confidence: .1 },
  ]) });
  expect(page.blocks).toHaveLength(1);
  expect(page.blocks[0]).toMatchObject({ text: "Recovered body sentence.", layoutManual: true });
  expect(page.excludedRegionIndices).toEqual([1]);
  expect(createSentenceUnits(page)[0].sourceRanges).toEqual([{ itemIndex: 0, start: 0, end: items[0].str.length }]);
});

test("sparse or mismatched geometry falls back without losing native items", () => {
  const items = [item("Original sentence.", 40, 100), item("Second sentence.", 40, 112)];
  const native = orderTextItems(items, styles, viewport);
  const mismatch = { ...layout([region(1, "text", 40, 100, 200, 22)]), width: 1200 };
  expect(orderTextItems(items, styles, viewport, { layout: mismatch })).toEqual(native);
  expect(orderTextItems(items, styles, viewport, { layout: layout([region(1, "text", 400, 700, 100, 20)]) })).toEqual(native);
});

test("valid Docling regions are parsed first even when a native PDF structure tree exists", () => {
  const items = [{ type: "beginMarkedContentProps", id: "body" }, item("A complete paragraph.", 40, 100), { type: "endMarkedContent" }];
  const structTree = { role: "Document", children: [{ role: "P", children: [{ type: "content", id: "body" }] }] };
  expect(orderTextItems(items, styles, viewport, { structTree }).mode).toBe("structured");
  const page = orderTextItems(items, styles, viewport, { structTree,
    layout: layout([region(1, "text", 40, 100, 200, 10, [cell(40, 100)])]) });
  expect(page.layoutSource).toBe("docling");
  expect(page.blocks[0].text).toBe("A complete paragraph.");
});

test("manual text/caption classification overrides graphic and footnote heuristics with original offsets intact", () => {
  const items = [item("Recovered body sentence.", 40, 650), item("Caption continuation.", 40, 690)];
  const page = orderTextItems(items, styles, viewport, { graphicRegions: [{ x: 30, y: 640, width: 230, height: 80 }],
    layout: layout([{ ...region(1, "text", 40, 650, 200, 10, [cell(40, 650)]), manual: true, confidence: .1 },
      { ...region(2, "caption", 40, 690, 200, 10, [cell(40, 690)]), manual: true }]) });
  expect(page.blocks.map(b => b.kind)).toEqual(["paragraph", "caption"]);
  expect(createSentenceUnits(page)[0].sourceRanges).toEqual([{ itemIndex: 0, start: 0, end: items[0].str.length }]);
  expect(filterDocumentBody([page])[0].blocks).toHaveLength(2);
});

test("explicit exclusions remove only their source region before indexing and sentence reconstruction", () => {
  const items = [item("Exclude this sentence.", 40, 100), item("Keep this sentence.", 40, 130)];
  const page = orderTextItems(items, styles, viewport, { layout: layout([
    { ...region(1, "text", 40, 100, 200, 10, [cell(40, 100)]), manual: true, excluded: true },
    region(2, "text", 40, 130, 200, 10, [cell(40, 130)]),
  ]) });
  expect(page.excludedRegionIndices).toEqual([0]);
  expect(page.blocks.map(b => b.text)).toEqual(["Keep this sentence."]);
  expect(createSentenceUnits(page)[0].sourceRanges).toEqual([{ itemIndex: 1, start: 0, end: items[1].str.length }]);
});

test("explicitly marking chart text as body overrides the existing caption-confirmed figure exclusion", () => {
  const items = [item("Recovered body.", 40, 160), item("Figure 1. Caption.", 40, 195), item("Normal body.", 40, 240)];
  const graph = { x: 30, y: 100, width: 230, height: 90 };
  const corrected = layout([{ ...region(1, "text", 40, 160, 200, 10, [cell(40, 160)]), manual: true },
    region(2, "caption", 40, 195, 200, 10, [cell(40, 195)]), region(3, "text", 40, 240, 200, 10, [cell(40, 240)])]);
  const page = orderTextItems(items, styles, viewport, { graphicRegions: [graph], layout: corrected });
  expect(page.excludedFigureIndices).toEqual([]);
  expect(page.blocks[0]).toMatchObject({ kind: 'paragraph', text: 'Recovered body.', layoutManual: true });
  expect(page.blocks.flatMap(b => b.sourceIndices).sort()).toEqual([0, 1, 2]);
});

test("splitting a merged picture/body region restores body and excludes only the picture with native offsets", async () => {
  const { applyRegionEdits, regionEditKey } = await import('../src/pdf/layout_edits');
  const items = [item('Chart ticks',40,100),item('Body recovered after splitting.',40,200)];
  const merged = region(1,'picture',30,90,230,130,[cell(40,100),cell(40,200)]);
  const raw = {pages:[layout([merged])],layoutIdentity:['original']};
  expect(orderTextItems(items,styles,viewport,{layout:raw.pages[0]}).blocks).toHaveLength(0);
  const edited = applyRegionEdits(raw,{[regionEditKey(raw.pages[0],merged)]:{parts:[
    {label:'picture',excluded:false,bbox:{x:30,y:90,width:230,height:70}},
    {label:'text',excluded:false,bbox:{x:30,y:160,width:230,height:60}}
  ]}});
  const parsed = orderTextItems(items,styles,viewport,{layout:edited.pages[0]});
  expect(parsed.excludedRegionIndices).toEqual([0]);
  expect(parsed.blocks.map(b=>b.text)).toEqual(['Body recovered after splitting.']);
  expect(createSentenceUnits(parsed)[0].sourceRanges).toEqual([{itemIndex:1,start:0,end:items[1].str.length}]);
  expect(filterDocumentBody([parsed])[0].blocks[0].layoutManual).toBe(true);
});

test('formula and table cells become one visual block per region with native character provenance',()=>{
 const items=[item('Before equation.',40,90),item('R',40,120,8),item('S',48,122,5,7),item('=',60,120,8),
  item('T',80,120,8),item('A',40,180,10),item('B',160,180,10),item('1',40,196,10),item('2',160,196,10),item('After table.',40,220)];
 const parsed=orderTextItems(items,styles,viewport,{layout:layout([
  region(1,'text',40,90,200,10),region(2,'formula',35,115,170,25,[cell(40,120,8),cell(48,122,5),cell(60,120,8),cell(80,120,8)]),
  region(3,'table',35,175,180,35,[cell(40,180,10),cell(160,180,10),cell(40,196,10),cell(160,196,10)]),region(4,'text',40,220,200,10)
 ])});
 expect(parsed.blocks.map(b=>b.kind)).toEqual(['paragraph','formula','table','paragraph']);
 expect(parsed.blocks[1].visualRegion.bbox).toEqual({x:35,y:115,width:170,height:25});
 expect(parsed.blocks[2].sourceIndices).toEqual([5,6,7,8]);
 expect(createSentenceUnits(parsed).filter(b=>b.kind==='table')).toHaveLength(1);
 expect(parsed.blocks.flatMap(b=>b.sourceIndices).sort((a,b)=>a-b)).toEqual(items.map((_,i)=>i));
});

test('a vector-only detected equation is shown; code is not dropped by visual grouping',()=>{
 const equation=orderTextItems([],styles,viewport,{layout:layout([region(1,'formula',40,100,200,40)])});
 expect(equation.blocks[0]).toMatchObject({kind:'formula',sourceIndices:[],visualRegion:{pageNumber:1}});
 const code=orderTextItems([item('printf(x);',40,100)],styles,viewport,{layout:layout([region(1,'code',40,100,200,10)])});
 expect(code.blocks[0].text).toBe('printf(x);');expect(code.blocks[0].visualRegion).toBeUndefined();
});
