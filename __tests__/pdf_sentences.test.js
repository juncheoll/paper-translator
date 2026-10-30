import { createSentenceUnits, createDocumentSentencePages } from "../src/pdf/sentences";
import { orderTextItems } from "../src/pdf/reading_order";
import { sourceText } from "../src/pdf/text_provenance";

const block = (id, text, extra = {}) => ({ id, text, kind: "paragraph", column: 1,
  bbox: { x: 20, y: 30, width: 200, height: 20 }, sourceIndices: [Number(id.replace(/\D/g, "")) || 0], ...extra });
const units = (...blocks) => createSentenceUnits({ pageNumber: 1, blocks });
const texts = (...blocks) => units(...blocks).map((unit) => unit.text);

test("physical PDF newlines do not split sentences and complete sentences become distinct units", () => {
  const original = block("p1-b1", "The trace is compiled\ninto native code.\nAnother sentence follows!");
  expect(texts(original)).toEqual(["The trace is compiled into native code.", "Another sentence follows!"]);
  expect(units(original).map((unit) => unit.id)).toEqual(["p1-b1-s1", "p1-b1-s2"]);
  expect(units(original)[0]).toMatchObject({ unitType: "sentence", kind: "paragraph", sourceBlockIds: ["p1-b1"] });
});

test("unfinished sentences continue across adjacent fragments and column transitions in reading order", () => {
  const input = [block("b1", "A trace is recorded that"),
    block("b2", "covers line 3 and returns to the loop header. Thus, the end of the trace"),
    block("b3", "jumps directly to the start.", { column: 2, bbox: { x: 300, y: 50, width: 200, height: 30 } })];
  const result = units(...input);
  expect(result.map((unit) => unit.text)).toEqual([
    "A trace is recorded that covers line 3 and returns to the loop header.",
    "Thus, the end of the trace jumps directly to the start.",
  ]);
  expect(result[0].sourceBlockIds).toEqual(["b1", "b2"]);
  expect(result[1].sourceBlockIds).toEqual(["b2", "b3"]);
  expect(result[1].bbox).toEqual({ x: 20, y: 30, width: 480, height: 50 });
  expect(result[1].sourceIndices).toEqual([2, 3]);
});

test("abbreviations, author initials, decimal values and citations remain in the sentence", () => {
  expect(texts(block("b1", "J. R. Smith et al. proposed this (Fig. 2), e.g. A faster case with 1.25 ms [12]. See Eq. (3). Next sentence.")))
    .toEqual(["J. R. Smith et al. proposed this (Fig. 2), e.g. A faster case with 1.25 ms [12].", "See Eq. (3).", "Next sentence."]);
  expect(texts(block("b1", "Use i.e. An expansion of the term. It works.")))
    .toEqual(["Use i.e. An expansion of the term.", "It works."]);
});

test("an abbreviation at a fragment boundary does not finish a sentence", () => {
  expect(texts(block("b1", "See Fig."), block("b2", "2 for the result. Next begins.")))
    .toEqual(["See Fig. 2 for the result.", "Next begins."]);
  expect(texts(block("b1", "Smith et al."), block("b2", "show the result. Next begins.")))
    .toEqual(["Smith et al. show the result.", "Next begins."]);
});

test("scientific variables ending a sentence are not mistaken for author initials", () => {
  expect(texts(block("b1", "We use type T. The next result follows. Reported by J. Smith.")))
    .toEqual(["We use type T.", "The next result follows.", "Reported by J. Smith."]);
  expect(texts(block("b1", "We worked in the U.S. The result holds.")))
    .toEqual(["We worked in the U.S.", "The result holds."]);
});

test("numeric citations after punctuation stay with the preceding sentence", () => {
  expect(texts(block("b1", "We agree. [12, 14–16] Next sentence. [17]")))
    .toEqual(["We agree. [12, 14–16]", "Next sentence. [17]"]);
});

test("soft hyphens and wrapped words are joined while hard compound hyphens remain", () => {
  expect(texts(block("b1", "An experi\u00ad\nmental trace-\nbased method is used.")))
    .toEqual(["An experimental trace-based method is used."]);
  expect(texts(block("b1", "An experi\u00ad"), block("b2", "mental approach is used.")))
    .toEqual(["An experimental approach is used."]);
  expect(texts(block("b1", "A trace-"), block("b2", "based approach is used.")))
    .toEqual(["A trace-based approach is used."]);
});

test("structural blocks remain intact and prevent prose being joined across them", () => {
  const input = [block("b1", "An unfinished fragment"), block("h1", "2. Methods", { kind: "heading" }),
    block("b2", "starts here. Ends here."), block("f1", "x = y.\nz = 2", { kind: "formula" }),
    block("t1", "A | B\n1 | 2", { kind: "table" })];
  const result = units(...input);
  expect(result.map((unit) => unit.text)).toEqual(["An unfinished fragment", "2. Methods", "starts here.", "Ends here.", "x = y.\nz = 2", "A | B\n1 | 2"]);
  expect(result.filter((unit) => unit.unitType === "block").map((unit) => unit.id)).toEqual(["h1", "f1", "t1"]);
});

test("a nearby lower-case caption continuation stays in the caption sentence", () => {
  const caption = block("c1", "Figure 1: Most LIR instructions compile", { kind: "caption" });
  const continuation = block("b2", "to a single x86 instruction. Results follow.", { bbox: { x: 20, y: 54, width: 200, height: 20 } });
  const result = units(caption, continuation);
  expect(result.map((unit) => unit.text)).toEqual(["Figure 1: Most LIR instructions compile to a single x86 instruction.", "Results follow."]);
  expect(result[0]).toMatchObject({ kind: "caption", sourceBlockIds: ["c1", "b2"] });
  const separate = units(caption, { ...continuation, bbox: { ...continuation.bbox, y: 200 } });
  expect(separate[0].text).toBe(caption.text);
});

test("complete paragraphs, footnotes and caption categories stay separate", () => {
  const result = units(block("b1", "First paragraph."), block("b2", "Second paragraph."),
    block("n1", "An unfinished footnote", { kind: "footnote" }), block("b3", "Body resumes."));
  expect(result.map((unit) => unit.text)).toEqual(["First paragraph.", "Second paragraph.", "An unfinished footnote", "Body resumes."]);
  expect(result[1].sourceBlockIds).toEqual(["b2"]);
});

test("a citation continuing in the right column joins the body without the separately ordered affiliation footer", () => {
  const left = "Therefore, system-level improvements reduce memory pressure (Eassa et al., 2024;";
  const right = "Srivastava, 2025; Li et al., 2025). The next sentence starts here.";
  const affiliation = "1 Example Research, California. Correspondence to: Author.";
  const result = units(
    block("left", left, { ...sourceText(left, 0), sourceIndices: [0] }),
    block("right", right, { ...sourceText(right, 1), sourceIndices: [1], column: 2 }),
    block("affiliation", affiliation, { ...sourceText(affiliation, 2), sourceIndices: [2], kind: "footnote" }),
  );
  expect(result[0].text).toBe(`${left} Srivastava, 2025; Li et al., 2025).`);
  expect(result[0].sourceBlockIds).toEqual(["left", "right"]);
  expect(result[0].sourceRanges).toEqual([
    { itemIndex: 0, start: 0, end: left.length },
    { itemIndex: 1, start: 0, end: "Srivastava, 2025; Li et al., 2025).".length },
  ]);
  expect(result[1].text).toBe("The next sentence starts here.");
  expect(result.filter((unit) => unit.kind === "paragraph").every((unit) => !unit.text.includes("Correspondence"))).toBe(true);
  expect(result.filter((unit) => unit.kind === "footnote").map((unit) => unit.text).join(" ")).toBe(affiliation);
});

test("a footnote never supplies the ending of an unfinished body sentence", () => {
  const result = units(
    block("body", "An unfinished body citation (Author et al., 2024;"),
    block("note", "1 Research Institute, California.", { kind: "footnote" }),
    block("continuation", "Other Author, 2025).", { column: 2 }),
  );
  expect(result.map((unit) => unit.sourceBlockIds)).toEqual([["body"], ["note"], ["continuation"]]);
  expect(result.map((unit) => unit.kind)).toEqual(["paragraph", "footnote", "paragraph"]);
});

test("Korean and CJK punctuation, quotes and long sentences are preserved", () => {
  expect(texts(block("b1", "줄바꿈이 있어도\n한 문장입니다. 다음 문장입니다! 「終わりました。」次の文。")))
    .toEqual(["줄바꿈이 있어도 한 문장입니다.", "다음 문장입니다!", "「終わりました。」", "次の文。"]);
  const long = "This is " + "one very long sentence ".repeat(100) + "without an internal full stop.";
  expect(texts(block("b1", long))).toEqual([long]);
});

test("sentence reconstruction neither mutates input nor omits or duplicates source text", () => {
  const input = [block("b1", "First sentence.\nThe second"), block("b2", "sentence ends. Third sentence.")];
  const snapshot = structuredClone(input);
  const result = units(...input);
  expect(result.map((unit) => unit.text).join(" ")).toBe("First sentence. The second sentence ends. Third sentence.");
  expect(new Set(result.map((unit) => unit.id)).size).toBe(result.length);
  expect(input).toEqual(snapshot);
});

const pdfItem = (str, y = 100, x = 40) => ({ str, fontName: "body", width: 220, height: 10,
  transform: [10, 0, 0, 10, x, 800 - y - 10] });
const pdfPage = (items, options = {}) => orderTextItems(items, { body: { ascent: 1, descent: 0 } },
  { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] }, options);

test("a sentence in the middle of a PDF text item selects only its own UTF-16 character range", () => {
  const str = "First sentence. Target sentence. Last sentence.";
  const items = [{ type: "beginMarkedContentProps", id: "a" }, pdfItem(str), { type: "endMarkedContent" }];
  const result = createSentenceUnits(pdfPage(items));
  const start = str.indexOf("Target"), end = str.indexOf(" Last");
  expect(result[1].text).toBe("Target sentence.");
  expect(result[1].sourceRanges).toEqual([{ itemIndex: 1, start, end }]);
  expect(result[1].textSpans).toEqual([{ start: 0, end: end - start, itemIndex: 1, sourceStart: start, sourceEnd: end }]);
});

test("multiline sentences clip both first and last text items without selecting adjacent sentences", () => {
  const items = [pdfItem("First sentence. A wrapped sentence"), pdfItem("continues here. Last sentence.", 114)];
  const result = createSentenceUnits(pdfPage(items));
  expect(result[1].text).toBe("A wrapped sentence continues here.");
  expect(result[1].sourceRanges).toEqual([
    { itemIndex: 0, start: items[0].str.indexOf("A wrapped"), end: items[0].str.length },
    { itemIndex: 1, start: 0, end: "continues here.".length },
  ]);
  expect(result[2].sourceRanges).toEqual([{ itemIndex: 1, start: items[1].str.indexOf("Last"), end: items[1].str.length }]);
});

test("source character ranges survive soft-hyphen removal and cross-column sentence reconstruction", () => {
  const items = [pdfItem("An experi\u00ad", 100), pdfItem("mental result. Next sentence.", 150, 330)];
  const result = createSentenceUnits(pdfPage(items, { mode: "two" }));
  expect(result[0].text).toBe("An experimental result.");
  expect(result[0].sourceRanges).toEqual([
    { itemIndex: 0, start: 0, end: items[0].str.length - 1 },
    { itemIndex: 1, start: 0, end: "mental result.".length },
  ]);
  expect(result[1].sourceRanges).toEqual([{ itemIndex: 1, start: items[1].str.indexOf("Next"), end: items[1].str.length }]);
});

test("source offsets keep surrogate pairs and structural source blocks intact", () => {
  const str = "A 😀 appears. 다음 문장입니다.";
  const result = createSentenceUnits(pdfPage([pdfItem(str)]));
  expect(result[1].sourceRanges).toEqual([{ itemIndex: 0, start: str.indexOf("다음"), end: str.length }]);
  const heading = createSentenceUnits(pdfPage([pdfItem("Abstract")]));
  expect(heading[0].unitType).toBe("block");
  expect(heading[0].sourceRanges).toEqual([{ itemIndex: 0, start: 0, end: "Abstract".length }]);
});

test("page-spanning sentences share one identity and preserve page-qualified source offsets", () => {
  const pages = [
    { pageNumber: 1, blocks: [block("p1", "The trace is", { ...sourceText("The trace is", 0) })] },
    { pageNumber: 2, blocks: [block("p2", "compiled. Next sentence.", { ...sourceText("compiled. Next sentence.", 0) })] },
  ];
  const snapshot = structuredClone(pages);
  const output = createDocumentSentencePages(pages);
  expect(output[0].blocks[0]).toBe(output[1].blocks[0]);
  expect(output[0].blocks[0]).toMatchObject({ id: "p1-s1", text: "The trace is compiled.", ownerPageNumber: 1, sourcePageNumbers: [1, 2] });
  expect(output[0].blocks[0].sourceRanges).toEqual([
    { pageNumber: 1, itemIndex: 0, start: 0, end: 12 }, { pageNumber: 2, itemIndex: 0, start: 0, end: 9 },
  ]);
  expect(output[1].blocks[1].text).toBe("Next sentence.");
  expect(pages).toEqual(snapshot);
});

test("three-page sentences update every displayed copy and join soft-hyphenated page endings", () => {
  const pages = ["An experi\u00ad", "mental result that", "continues here."].map((text, i) => ({
    pageNumber: i + 1, blocks: [block(`p${i + 1}`, text, { ...sourceText(text, 0) })],
  }));
  const result = createDocumentSentencePages(pages);
  expect(result.map((page) => page.blocks[0].text)).toEqual(Array(3).fill("An experimental result that continues here."));
  expect(new Set(result.map((page) => page.blocks[0].id)).size).toBe(1);
  expect(result[0].blocks[0].sourceRanges.map((range) => range.pageNumber)).toEqual([1, 2, 3]);
});

test("floating captions and notes do not interrupt page continuations but headings and lists do", () => {
  const make = (first) => createDocumentSentencePages([
    { pageNumber: 1, blocks: [block("body", "A sentence that"), block("note", "A footnote.", { kind: "footnote" })] },
    { pageNumber: 2, blocks: first },
  ]);
  const result = make([block("caption", "Figure 1. A plot.", { kind: "caption" }), block("next", "continues here.")]);
  expect(result[0].blocks[0].text).toBe("A sentence that continues here.");
  expect(result[1].blocks[0].kind).toBe("caption");
  expect(make([block("heading", "Methods", { kind: "heading" }), block("next", "New section.")])[0].blocks[0].text).toBe("A sentence that");
  expect(make([block("list", "1. A numbered list item.")])[0].blocks[0].text).toBe("A sentence that");
  const complete = createDocumentSentencePages([{ pageNumber: 1, blocks: [block("a", "This ends.")] },
    { pageNumber: 2, blocks: [block("b", "New sentence.")] }]);
  expect(complete[0].blocks[0].sourcePageNumbers).toEqual([1]);
});
