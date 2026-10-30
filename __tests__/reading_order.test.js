import { extractOrderedPage, orderTextItems } from "../src/pdf/reading_order";
import { createSentenceUnits } from "../src/pdf/sentences";
import { getDisplayParagraphs } from "../src/pdf/display_paragraphs";

const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
const styles = { body: { ascent: 1, descent: 0 } };
const item = (text, x, y, width = 220, height = 10) => ({
  str: text, transform: [height, 0, 0, height, x, 800 - y - height], width, height,
  fontName: "body", hasEOL: true, dir: "ltr",
});
const texts = (page) => page.blocks.map((block) => block.text).join(" | ");
function expectCoverage(page, items) {
  const expected = items.map((i, index) => i.str?.trim() ? index : null).filter((i) => i != null).sort((a, b) => a - b);
  const actual = page.blocks.flatMap((b) => b.sourceIndices).sort((a, b) => a - b);
  expect(actual).toEqual(expected);
}

test("two-column body is read down the left column before the right, even with interleaved drawing order", () => {
  const items = [item("Right one", 330, 100), item("Left two", 40, 114), item("Right two", 330, 114), item("Left one", 40, 100)];
  const page = orderTextItems(items, styles, viewport);
  expect(page.mode).toBe("two");
  expect(texts(page)).toBe("Left one Left two | Right one Right two");
  expect(page.blocks.map((block) => block.column)).toEqual([1, 2]);
  expectCoverage(page, items);
});

test("full-width title and middle caption divide the page into separately ordered column bands", () => {
  const items = [
    item("A Full Width Research Title", 40, 30, 510, 20),
    item("Left above one", 40, 100), item("Right above one", 330, 100),
    item("Left above two", 40, 114), item("Right above two", 330, 114),
    item("Figure 1: Full-width experiment overview", 40, 180, 510, 10),
    item("Left below one", 40, 220), item("Right below one", 330, 220),
    item("Left below two", 40, 234), item("Right below two", 330, 234),
  ];
  const page = orderTextItems(items, styles, viewport);
  expect(texts(page)).toBe("A Full Width Research Title | Left above one Left above two | Right above one Right above two | Figure 1: Full-width experiment overview | Left below one Left below two | Right below one Right below two");
  expect(page.blocks[0].kind).toBe("heading");
  expect(page.blocks[3].kind).toBe("caption");
  expectCoverage(page, items);
});

test("a full-width caption keeps every wrapped sentence, including its short final line, in one displayed paragraph", () => {
  const caption = ["Figure 3. Overview of expert replication. The total",
    "height of a bar represents balancedness. A higher portion of the",
    "bar implies a larger contribution. Excluded layers are dense."];
  const items = [
    ...caption.map((text, i) => item(text, 40, 250 + i * 11, i === 2 ? 270 : 510, 9)),
    item("Left body first.", 40, 310), item("Left body second.", 40, 324),
    item("Right body first.", 330, 310), item("Right body second.", 330, 324),
  ];
  const page = orderTextItems(items, styles, viewport);
  const captions = page.blocks.filter((block) => block.kind === "caption");
  expect(captions.map((block) => block.text)).toEqual([caption.join(" ")]);
  const units = createSentenceUnits(page);
  const groups = getDisplayParagraphs({ ...page, blocks: units }, items, viewport);
  const captionUnits = units.filter((unit) => unit.kind === "caption");
  expect(captionUnits).toHaveLength(5);
  expect(new Set(captionUnits.map((unit) => groups.get(unit.id))).size).toBe(1);
  expect(page.blocks.find((block) => block.text.startsWith("Left body")).kind).toBe("paragraph");
  expectCoverage(page, items);
});

test("figure subpanel references inside a caption stay in that caption while a later body reference stays prose", () => {
  const caption = ["Figure 10. Shifting workload mix ratios across eight nodes.",
    "Figure 10(a) depicts the ratio. Figures 10(b) - 10(d) show the achieved",
    "balancedness under different configurations. The lines are smoothed.",
    "Workloads with higher burstiness retain the same shifting patterns."];
  const items = [
    ...caption.map((text, i) => item(text, 40, 250 + i * 11, 510, 9)),
    item("Figure 10(a) also appears in the body discussion.", 40, 330),
    item("The body explanation continues.", 40, 344),
    item("Right body first.", 330, 330), item("Right body second.", 330, 344),
  ];
  const page = orderTextItems(items, styles, viewport);
  expect(page.blocks.filter((block) => block.kind === "caption").map((block) => block.text)).toEqual([caption.join(" ")]);
  expect(page.blocks.find((block) => block.text.startsWith("Figure 10(a) also")).kind).toBe("paragraph");
  expectCoverage(page, items);
});

test.each([
  "Figure 1 shows the throughput of our method.",
  "Fig. 2 illustrates the architecture.",
  "Table II compares the baselines.",
  "Figure 1.2 discusses the same experiment.",
])("a body reference stays ordinary prose: %s", (reference) => {
  const items = [item("An ordinary body paragraph establishes the text size.", 40, 100),
    item(reference, 40, 150), item("The discussion continues on the next line.", 40, 164)];
  const page = orderTextItems(items, styles, viewport);
  expect(page.blocks.find((block) => block.text.startsWith(reference)).kind).toBe("paragraph");
  expect(page.blocks.some((block) => block.kind === "caption")).toBe(false);
  expectCoverage(page, items);
});

test.each(["Figure 1: Overview.", "Figure 1.Overview.", "Fig. 2. Overview.", "Table II. Results."])(
  "explicit caption labels remain captions: %s", (caption) => {
    const items = [item("Ordinary body text.", 40, 100), item(caption, 40, 220)];
    const page = orderTextItems(items, styles, viewport);
    expect(page.blocks.find((block) => block.text === caption).kind).toBe("caption");
    expectCoverage(page, items);
  });

test("an unpunctuated label needs both a smaller font and a nearby graphic to become a caption", () => {
  const graphicRegions = [{ x: 40, y: 100, width: 220, height: 100 }];
  const make = (height, options) => orderTextItems([
    item("Ordinary body text establishes the body font size.", 40, 50),
    item("Another ordinary body line establishes the size.", 40, 64),
    item("Figure 1 Architecture of the proposed method", 40, 220, 220, height),
  ], styles, viewport, options).blocks.at(-1);
  expect(make(9, { graphicRegions }).kind).toBe("caption");
  expect(make(9, {}).kind).toBe("paragraph");
  expect(make(10, { graphicRegions }).kind).toBe("paragraph");
  expect(make(9, { graphicRegions: [{ x: 330, y: 100, width: 220, height: 100 }] }).kind).toBe("paragraph");
});

test("PDF structure tags distinguish a caption from body prose regardless of its opening words", () => {
  const items = [
    { type: "beginMarkedContentProps", id: "caption" }, item("System architecture without a numbered label.", 40, 100), { type: "endMarkedContent" },
    { type: "beginMarkedContentProps", id: "body" }, item("Figure 1: this text is explicitly tagged as a paragraph.", 40, 200), { type: "endMarkedContent" },
  ];
  const tree = { role: "Document", children: [
    { role: "Caption", children: [{ type: "content", id: "caption" }] },
    { role: "P", children: [{ type: "content", id: "body" }] },
  ] };
  const page = orderTextItems(items, styles, viewport, { structTree: tree });
  expect(page.blocks.map((block) => block.kind)).toEqual(["caption", "paragraph"]);
  expectCoverage(page, items);
});

test("single-column abstract before two-column body stays ahead of both columns", () => {
  const items = [
    item("Abstract across the full text width", 40, 30, 510),
    item("The second abstract line has full width", 40, 44, 510),
    item("Left one", 40, 100), item("Right one", 330, 100),
    item("Left two", 40, 114), item("Right two", 330, 114),
  ];
  const page = orderTextItems(items, styles, viewport);
  expect(texts(page).indexOf("second abstract")).toBeLessThan(texts(page).indexOf("Left one"));
  expect(texts(page).indexOf("Left two")).toBeLessThan(texts(page).indexOf("Right one"));
  expectCoverage(page, items);
});

test("manual single and two column modes override automatic and structured ordering", () => {
  const items = [item("A", 40, 100), item("B", 330, 100), item("C", 40, 150), item("D", 330, 150)];
  const single = orderTextItems(items, styles, viewport, { mode: "single" });
  expect(single.mode).toBe("single");
  expect(texts(single)).toBe("A | B | C | D");
  const two = orderTextItems(items, styles, viewport, { mode: "two" });
  expect(texts(two)).toBe("A | C | B | D");
  expectCoverage(single, items);
  expectCoverage(two, items);
});

test("complete marked-content structure is preferred and exposes heading/table kinds", () => {
  const items = [
    { type: "beginMarkedContentProps", id: "p1_title" }, item("Title", 40, 30, 100, 20), { type: "endMarkedContent" },
    { type: "beginMarkedContentProps", id: "p1_table" }, item("Method Accuracy", 40, 100), { type: "endMarkedContent" },
    { type: "beginMarkedContentProps", id: "p1_p" }, item("Body", 40, 70), { type: "endMarkedContent" },
  ];
  const tree = { role: "Document", children: [
    { role: "H1", children: [{ type: "content", id: "p1_title" }] },
    { role: "P", children: [{ type: "content", id: "p1_p" }] },
    { role: "Table", children: [{ role: "TR", children: [{ role: "TD", children: [{ type: "content", id: "p1_table" }] }] }] },
  ] };
  const page = orderTextItems(items, styles, viewport, { structTree: tree });
  expect(page.mode).toBe("structured");
  expect(page.blocks.map((b) => b.kind)).toEqual(["heading", "paragraph", "table"]);
  expect(texts(page)).toBe("Title | Body | Method Accuracy");
  expectCoverage(page, items);
});

test("incomplete structure falls back without silently dropping unmapped text", () => {
  const items = [{ type: "beginMarkedContentProps", id: "a" }, item("Mapped", 40, 30), { type: "endMarkedContent" }, item("Unmapped", 40, 70)];
  const page = orderTextItems(items, styles, viewport, { structTree: { role: "P", children: [{ type: "content", id: "a" }] } });
  expect(page.mode).toBe("single");
  expect(page.warnings.join(" ")).toMatch(/Incomplete/);
  expectCoverage(page, items);
});

test("line fragments, superscripts and hyphenated continuations remain in source coverage", () => {
  const items = [item("An experi-", 40, 100, 70), item("mental approach", 40, 114, 100), item("x", 40, 160, 7), item("2", 47, 157, 4, 6), item(" = 1", 54, 160, 25)];
  const page = orderTextItems(items, styles, viewport);
  expect(texts(page)).toContain("experi-mental approach");
  expect(texts(page)).toMatch(/x\s*2\s*= 1/);
  expectCoverage(page, items);
});

test("footnotes and formulas are separate from ordinary prose", () => {
  const items = [item("Body paragraph", 40, 100), item("x = y + 1", 40, 150, 120), item("Small footnote", 40, 740, 160, 7)];
  const page = orderTextItems(items, styles, viewport);
  expect(page.blocks.map((block) => block.kind)).toEqual(["paragraph", "formula", "footnote"]);
  expectCoverage(page, items);
});

test("viewport rotation normalizes source boxes into displayed top-left coordinates", () => {
  const raw = { str: "Rotated", transform: [10, 0, 0, 10, 50, 700], width: 100, height: 10, fontName: "body" };
  const page = orderTextItems([raw], styles, { width: 800, height: 600, transform: [0, 1, 1, 0, 0, 0] }, { pageNumber: 3 });
  expect(page.blocks[0].bbox).toEqual({ x: 700, y: 50, width: 10, height: 100 });
  expect(page.blocks[0].id).toBe("p3-b1");
  expect(page.warnings.join(" ")).toMatch(/Rotated/);
});

test("page extraction requests complete text metadata and tolerates an unavailable structure tree", async () => {
  const raw = [item("Text", 40, 100)];
  const page = {
    pageNumber: 2, getViewport: jest.fn(() => viewport),
    getTextContent: jest.fn(async () => ({ items: raw, styles })),
    getStructTree: jest.fn(async () => { throw new Error("Not available"); }),
  };
  const result = await extractOrderedPage(page);
  expect(page.getTextContent).toHaveBeenCalledWith({ includeMarkedContent: true, disableNormalization: true });
  expect(result.pageNumber).toBe(2);
  expectCoverage(result, raw);
  const empty = orderTextItems([], styles, viewport);
  expect(empty.blocks).toEqual([]);
  expect(empty.warnings.join(" ")).toMatch(/OCR/);
});

test("aligned table rows stay row-major and retain source separately from body prose", () => {
  const items = [
    item("Method", 40, 100, 70), item("Time", 200, 100, 40), item("Accuracy", 360, 100, 70),
    item("Baseline", 40, 114, 70), item("10", 200, 114, 30), item("95", 360, 114, 30),
    item("Body after table", 40, 180, 500),
  ];
  const page = orderTextItems(items, styles, viewport);
  expect(texts(page)).toContain("Method | Time | Accuracy");
  expect(texts(page)).toContain("Baseline | 10 | 95");
  expect(page.blocks.some((block) => block.kind === "table")).toBe(true);
  expect(page.warnings.join(" ")).toMatch(/table/i);
  expectCoverage(page, items);
});

test("page footnotes follow body columns instead of interrupting the main text", () => {
  const items = [
    item("Left first", 40, 100), item("Left second", 40, 114),
    item("Right first", 330, 100), item("Right second", 330, 114),
    item("Left footnote", 40, 740, 180, 7), item("Right footnote", 330, 740, 180, 7),
  ];
  const page = orderTextItems(items, styles, viewport);
  const bodyEnd = page.blocks.findIndex((block) => block.kind === "footnote");
  expect(page.blocks.slice(0, bodyEnd).every((block) => block.kind !== "footnote")).toBe(true);
  expect(texts(page).indexOf("Right second")).toBeLessThan(texts(page).indexOf("Left footnote"));
  expectCoverage(page, items);
});

test("superscript-led nine-point footer notes and their continuation stay outside ten-point body columns", () => {
  const items = [
    item("Left introduction text fills a normal body line.", 40, 100),
    item("A second body line establishes ordinary text size.", 40, 114),
    item("Therefore, the full sentence continues (Smith et al., 2024;", 40, 620),
    item("Jones, 2025). The next paragraph follows.", 330, 100),
    item("Right body continues with its own normal paragraph.", 330, 114),
    item("The right column continues below the left footer.", 330, 674),
    item("1", 52, 657, 3, 6), item("Example Institute, City, Country", 56, 660, 190, 9),
    item("2", 52, 668, 3, 6), item("Department of Computing, Example University", 56, 671, 200, 9),
    item("Correspondence to: Researcher <contact@example.edu>.", 40, 682, 220, 9),
  ];
  const page = orderTextItems(items, styles, viewport, { mode: "two" });
  const notes = page.blocks.filter((block) => block.kind === "footnote");
  expect(notes.map((block) => block.text).join(" ")).toContain("Example Institute");
  expect(notes.map((block) => block.text).join(" ")).toContain("Correspondence to:");
  expect(page.blocks.filter((block) => block.kind !== "footnote").some((block) => /Example Institute|Correspondence to:/.test(block.text))).toBe(false);
  expect(texts(page).indexOf("right column continues")).toBeLessThan(texts(page).indexOf("Example Institute"));
  expectCoverage(page, items);
});

test("lower-page small captions and ordinary numbered body headings do not become footnotes", () => {
  const items = [
    item("Normal body text before the illustration.", 40, 100),
    item("Another normal body line for font estimation.", 40, 114),
    item("Normal right-column body text begins here.", 330, 100),
    item("Another normal right-column body line follows.", 330, 114),
    item("Figure 3: A small caption at the foot of the page", 40, 650, 220, 9),
    item("with a continuation explaining the illustration.", 40, 661, 220, 9),
    item("3 Results", 330, 650, 100, 10),
    item("Ordinary body text remains beside the caption.", 330, 664, 220, 10),
  ];
  const page = orderTextItems(items, styles, viewport, { mode: "two" });
  expect(page.blocks.some((block) => block.kind === "footnote")).toBe(false);
  expect(page.blocks.some((block) => block.kind === "caption" && block.text.includes("continuation"))).toBe(true);
  expectCoverage(page, items);
});

test("numbered section titles are separate even when their font is the body size", () => {
  const items = [item("3.1 Traces", 40, 100, 90), item("A trace is a program path.", 40, 114, 220)];
  const page = orderTextItems(items, styles, viewport);
  expect(page.blocks.map((block) => block.kind)).toEqual(["heading", "paragraph"]);
});

test("number-led body continuations remain in complete prose sentences instead of becoming section titles", () => {
  const items = [
    item("Our experiments use instances, each equipped with", 40, 100),
    item("8 NVIDIA A100 GPUs (80 GB each) interconnected via", 40, 114),
    item("NVLink. Another sentence follows.", 40, 128),
    item("We use DeepSeek-R1-671B with", 40, 180),
    item("58 MoE layers (layers 3 - 60) and 256 experts (Guo et al.,", 40, 194),
    item("2025), and another model.", 40, 208),
    item("Right body first.", 330, 100), item("Right body second.", 330, 114),
  ];
  const page = orderTextItems(items, styles, viewport);
  expect(page.blocks.some((block) => block.kind === "heading")).toBe(false);
  const sentences = createSentenceUnits(page).map((unit) => unit.text);
  expect(sentences).toContain("Our experiments use instances, each equipped with 8 NVIDIA A100 GPUs (80 GB each) interconnected via NVLink.");
  expect(sentences).toContain("We use DeepSeek-R1-671B with 58 MoE layers (layers 3 - 60) and 256 experts (Guo et al., 2025), and another model.");
  expectCoverage(page, items);
});

test("same-size numbered headings keep their distinct font, paragraph boundary or section spacing", () => {
  const items = [
    item("An unfinished-looking paragraph clause", 40, 100),
    { ...item("3 Experimental Setup", 40, 114), fontName: "bold" },
    item("This section has a complete paragraph.", 40, 145),
    item("4 Results", 40, 159),
    item("A further unfinished-looking clause", 40, 190),
    item("5 Discussion", 40, 225),
  ];
  const page = orderTextItems(items, { ...styles, bold: styles.body }, viewport);
  expect(page.blocks.filter((block) => block.kind === "heading").map((block) => block.text))
    .toEqual(["3 Experimental Setup", "4 Results", "5 Discussion"]);
  expectCoverage(page, items);
});

test("a full-width code listing does not hide a two-column body below it", () => {
  const items = [
    ...Array.from({ length: 8 }, (_, i) => ({ ...item(`code${i}`, 40, 30 + i * 12, 70), fontName: "mono" })),
    ...Array.from({ length: 8 }, (_, i) => ({ ...item(`comment${i}`, 200, 30 + i * 12, 290), fontName: "mono" })),
    item("Figure 1: A full-width code listing and comments", 40, 150, 510),
    item("Left first", 40, 200), item("Right first", 330, 200),
    item("Left second", 40, 214), item("Right second", 330, 214),
  ];
  const page = orderTextItems(items, { ...styles, mono: { ascent: 1, descent: 0, fontFamily: "monospace" } }, viewport);
  expect(page.mode).toBe("two");
  expect(texts(page)).toContain("code0 comment0");
  expect(texts(page).indexOf("Left second")).toBeLessThan(texts(page).indexOf("Right first"));
  expectCoverage(page, items);
});

test("adjacent centered title lines form one heading without absorbing authors or abstract", () => {
  const items = [
    item("Context-Aware Translation for Technical", 50, 30, 500, 20),
    item("Documents", 240, 54, 120, 20),
    item("Alice Author and Bob Author", 150, 92, 300, 11),
    item("Abstract", 260, 122, 80, 10),
    item("The abstract is ordinary paragraph text.", 50, 140, 500),
    item("Left first", 40, 200), item("Right first", 330, 200),
    item("Left second", 40, 214), item("Right second", 330, 214),
  ];
  const page = orderTextItems(items, styles, viewport);
  expect(page.blocks[0].text).toBe("Context-Aware Translation for Technical Documents");
  expect(page.blocks[0].kind).toBe("heading");
  expect(page.blocks[0].sourceIndices).toEqual([0, 1]);
  expect(page.blocks[1].text).toBe("Alice Author and Bob Author");
  expect(page.blocks[2].text).toBe("Abstract");
  expect(page.blocks[3].text).toBe("The abstract is ordinary paragraph text.");
  expectCoverage(page, items);
});

test("separate numbered headings and intervening body bands are not joined", () => {
  const items = [
    item("1 Introduction", 50, 30, 500, 20),
    item("2 Methods", 220, 54, 160, 20),
    item("Left first", 40, 100), item("Right first", 330, 100),
    item("Left second", 40, 114), item("Right second", 330, 114),
    item("Methods continued", 130, 180, 340, 20),
  ];
  const page = orderTextItems(items, styles, viewport);
  expect(page.blocks[0].text).toBe("1 Introduction");
  expect(page.blocks[1].text).toBe("2 Methods");
  expect(page.blocks[page.blocks.length - 1].text).toBe("Methods continued");
  expectCoverage(page, items);
});

test("raw item character spans follow normalized line and paragraph text through marked-content entries", () => {
  const items = [{ type: "beginMarkedContentProps", id: "a" },
    item("  First sentence. Second", 40, 100), item("continues here.", 40, 114),
    { type: "endMarkedContent" }];
  const page = orderTextItems(items, styles, viewport);
  const block = page.blocks[0];
  expect(block.text).toBe("First sentence. Second continues here.");
  for (const span of block.textSpans) {
    expect(block.text.slice(span.start, span.end))
      .toBe(items[span.itemIndex].str.slice(span.sourceStart, span.sourceEnd));
  }
  expect(block.textSpans.map((span) => span.itemIndex)).toEqual([1, 2]);
  expect(block.textSpans[0].sourceStart).toBe(2);
  expect(block.textSpans[1].start).toBe("First sentence. Second ".length);
});

test("structured table and centered-heading joins retain exact raw source character offsets", () => {
  const items = [
    { type: "beginMarkedContentProps", id: "title" }, item("Centered Title", 50, 30, 500, 20), { type: "endMarkedContent" },
    { type: "beginMarkedContentProps", id: "title2" }, item("Continued", 240, 54, 120, 20), { type: "endMarkedContent" },
    { type: "beginMarkedContentProps", id: "table" }, item("A  B", 40, 100), { type: "endMarkedContent" },
  ];
  const tree = { role: "Document", children: [
    { role: "H1", children: [{ type: "content", id: "title" }, { type: "content", id: "title2" }] },
    { role: "Table", children: [{ type: "content", id: "table" }] },
  ] };
  const page = orderTextItems(items, styles, viewport, { structTree: tree });
  expect(page.mode).toBe("structured");
  expect(page.blocks[0].text).toBe("Centered Title Continued");
  expect(page.blocks[0].textSpans.map((span) => span.itemIndex)).toEqual([1, 4]);
  expect(page.blocks[1].text).toBe("A B");
  expect(page.blocks[1].textSpans.map((span) => items[span.itemIndex].str.slice(span.sourceStart, span.sourceEnd)).join(""))
    .toBe("A B");
});

test("fragmented centered front matter cannot erase a narrow repeated two-column gutter", () => {
  const items = [
    item("A broad research title", 70, 30, 225, 20), item("continued", 310, 30, 230, 20),
    item("A", 285, 70, 18), item("B", 305, 70, 18),
    item("A full-width abstract extends across the central gap.", 75, 110, 446),
    ...Array.from({ length: 12 }, (_, n) => [
      item(`Left line ${n}`, 55, 180 + n * 12, 236), item(`Right line ${n}`, 307, 180 + n * 12, 236),
    ]).flat(),
  ];
  const page = orderTextItems(items, styles, { ...viewport, width: 612 });
  expect(page.mode).toBe("two");
  const body = page.blocks.filter((block) => /Left line|Right line/.test(block.text));
  expect(body.every((block) => !(block.text.includes("Left line") && block.text.includes("Right line")))).toBe(true);
  expect(texts(page).indexOf("Left line 11")).toBeLessThan(texts(page).indexOf("Right line 0"));
  expectCoverage(page, items);
});
