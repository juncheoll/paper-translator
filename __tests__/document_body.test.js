import { filterDocumentBody } from "../src/pdf/document_body";

const block = (id, text, y, { kind = "paragraph", height = 10, x = 50, width = 240 } = {}) => ({
  id, text, kind, column: 1, bbox: { x, y, width, height }, sourceIndices: [Number(id.replace(/\D/g, "")) || 0],
});
const page = (pageNumber, blocks) => ({ pageNumber, width: 600, height: 800, blocks });
const ids = (pages) => pages.map((item) => item.blocks.map((item) => item.id));

test("removes recurring margin titles and page-number variations while preserving first-page title and body", () => {
  const input = [
    page(1, [block("title", "Understanding trace compilation", 40, { kind: "heading" }), block("b1", "Article body.", 110), block("f1", "Journal of Computing | 1", 760)]),
    page(2, [block("h2", "Understanding trace compilation", 40), block("b2", "Article body.", 110), block("f2", "Journal of Computing | 2", 760)]),
    page(3, [block("h3", "Understanding trace compilation", 40), block("b3", "Article body.", 110), block("f3", "Journal of Computing | 3", 760)]),
  ];
  const result = filterDocumentBody(input);
  expect(ids(result)).toEqual([["title", "b1"], ["b2"], ["b3"]]);
  expect(result.map((item) => item.excludedBlockCount)).toEqual([1, 2, 2]);
});

test("isolated Arabic and Roman page numbers are removed only from page margins", () => {
  const result = filterDocumentBody([page(1, [
    block("n1", "Page 12 of 30", 760), block("n2", "iv", 30), block("body", "12", 350),
  ])]);
  expect(ids(result)).toEqual([["body"]]);
});

test("a recurring first-page header paragraph is removed while the article heading remains", () => {
  const input = [1, 2].map((n) => page(n, [
    block(`header${n}`, "A. Researcher et al.", 20),
    block(`article${n}`, n === 1 ? "An article title" : "Scientific content.", 120, { kind: n === 1 ? "heading" : "paragraph" }),
  ]));
  expect(ids(filterDocumentBody(input))).toEqual([["article1"], ["article2"]]);
});

test("preserves section headings, tables, captions and large body blocks that touch the top margin", () => {
  const input = [1, 2].map((n) => page(n, [
    block(`section${n}`, `${n}. Methods`, 60, { kind: "heading" }),
    block(`table${n}`, "Data | Results", 40, { kind: "table" }),
    block(`caption${n}`, "Figure 1. An overview.", 40, { kind: "caption" }),
    block(`formula${n}`, "1", 40, { kind: "formula" }),
    block(`body${n}`, "The same scientific paragraph starts near the top and continues below it.", 60, { height: 120 }),
  ]));
  expect(ids(filterDocumentBody(input))).toEqual(ids(input));
});

test("first-page publication details are removed without removing title, authors, affiliations or abstract", () => {
  const input = [page(1, [
    block("journal", "Journal of Computer Science, Volume 12", 15, { kind: "heading" }),
    block("title", "Understanding trace compilation", 100, { kind: "heading", height: 30 }),
    block("authors", "Andreas Gal, Brendan Eich", 145),
    block("affiliation", "University of California, Irvine", 165),
    block("doi", "https://doi.org/10.1145/1234567.1234568", 185),
    block("date", "Accepted: 12 October 2024", 190),
    block("abstract", "Abstract", 215, { kind: "heading" }),
    block("body", "We present a trace compiler.", 235),
    block("notice", "Permission to make digital or hard copies of all or part of this work for personal use is granted. Copyright © 2009 ACM.", 680, { kind: "footnote", height: 40 }),
  ])];
  expect(ids(filterDocumentBody(input))).toEqual([["title", "authors", "affiliation", "abstract", "body"]]);
});

test("bounded license continuations are omitted but the next scientific footnote remains", () => {
  const input = [page(1, [
    block("notice", "Permission to make digital or hard copies", 670, { kind: "footnote" }),
    block("continuation", "for personal or classroom use is granted without fee.", 682, { kind: "footnote" }),
    block("copyright", "Copyright © 2009 ACM", 694, { kind: "footnote" }),
    block("note", "1 We use a different evaluation protocol.", 706, { kind: "footnote" }),
  ])];
  expect(ids(filterDocumentBody(input))).toEqual([["note"]]);
});

test("scientific DOI, copyright, journal and publication mentions are retained in body and later-page notes", () => {
  const input = [page(1, [
    block("copyright", "Copyright infringement detection is the task studied in this paper.", 300),
    block("doi", "DOI: 10.1234/example identifies the dataset used in our experiment.", 320),
    block("journal", "Journal of science publications is one of our evaluation categories.", 340),
    block("note", "The copyright transform improves robustness in this model.", 690, { kind: "footnote" }),
    block("doiNote", "DOI: 10.1234/example identifies the dataset used in our experiment.", 700, { kind: "footnote" }),
    block("journalNote", "Journal of science publications is one of our evaluation categories.", 715, { kind: "footnote" }),
    block("dateNote", "Published 2024 results are used in our comparison.", 730, { kind: "footnote" }),
  ]), page(2, [block("reference", "Published 2024: a comparison study.", 60)])];
  expect(ids(filterDocumentBody(input))).toEqual(ids(input));
});

test("first-page bottom affiliation and correspondence notes are omitted while scientific footnotes remain", () => {
  const input = [page(1, [
    block("affiliationTop", "Department of Computer Science, Research University", 150),
    block("body", "The sentence continues in the other column.", 600),
    block("authorFooter", "1Example Research, Mountain City, State, USA 2Department of Computer Science, Research University. Correspondence to: A. Author <author@example.org>.", 655, { kind: "footnote", height: 30 }),
    block("scientificNote", "1 We use GPUs at Research University for all measurements.", 700, { kind: "footnote" }),
  ]), page(2, [block("laterNote", "1Department of Computer Science, Research University", 700, { kind: "footnote" })])];
  expect(ids(filterDocumentBody(input))).toEqual([["affiliationTop", "body", "scientificNote"], ["laterNote"]]);
});

test("nearby affiliation address continuations are removed without absorbing the next numbered scientific note", () => {
  const input = [page(1, [
    block("institution", "1Department of Computer Science, Research University", 650, { kind: "footnote" }),
    block("address", "Mountain City, State, Country.", 662, { kind: "footnote" }),
    block("correspondence", "Correspondence to: A. Author <author@example.org>.", 674, { kind: "footnote" }),
    block("scientific", "2 A separate evaluation protocol is applied here.", 686, { kind: "footnote" }),
  ])];
  expect(ids(filterDocumentBody(input))).toEqual([["scientific"]]);
});

test("filtering preserves original block IDs and does not mutate input pages", () => {
  const original = [page(1, [block("kept", "Article body.", 200), block("number", "1", 760)])];
  const snapshot = structuredClone(original);
  const result = filterDocumentBody(original);
  expect(original).toEqual(snapshot);
  expect(result[0]).not.toBe(original[0]);
  expect(result[0].blocks[0]).toBe(original[0].blocks[0]);
  expect(filterDocumentBody(result)[0].excludedBlockCount).toBe(1);
});
