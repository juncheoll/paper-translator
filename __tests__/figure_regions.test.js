import { extractGraphicRegions, figureRegionsNearCaptions } from "../src/pdf/figure_regions";
import { orderTextItems } from "../src/pdf/reading_order";

const ops = { save: 1, restore: 2, transform: 3, paintImageXObject: 4, paintFormXObjectBegin: 5,
  paintFormXObjectEnd: 6, constructPath: 7, stroke: 8, endPath: 9, beginGroup: 10, endGroup: 11 };
const viewport = { width: 600, height: 800, transform: [1, 0, 0, -1, 0, 800] };
const image = { fnArray: [1, 3, 4, 2], argsArray: [[], [200, 0, 0, 100, 40, 600], ["image"], []] };

test("image bounds follow PDF transformations and save/restore", () => {
  expect(extractGraphicRegions(image, viewport, ops)).toEqual([{ x: 40, y: 100, width: 200, height: 100 }]);
});

test("unpainted clipping rectangles and text-only forms cannot define figure content", () => {
  const list = { fnArray: [5, 7, 9, 6], argsArray: [[null, [40, 600, 240, 700]], [[], [], [40, 600, 240, 700]], [], []] };
  expect(extractGraphicRegions(list, viewport, ops)).toEqual([]);
});

test("figure captions validate graphic regions while table captions keep their contents", () => {
  const region = { x: 40, y: 100, width: 200, height: 100 };
  const caption = { text: "Figure 2. A chart.", box: { x: 40, y: 220, width: 220, height: 10 } };
  expect(figureRegionsNearCaptions([caption], [region])).toEqual([{ ...region, height: 119 }]);
  expect(figureRegionsNearCaptions([{ ...caption, text: "Table 2. Results." }], [region])).toEqual([]);
  expect(figureRegionsNearCaptions([{ ...caption, box: { ...caption.box, y: 400 } }], [region])).toEqual([]);
});

const item = (str, x, y, width = 180, height = 10) => ({ str, fontName: "body", width, height,
  transform: [height, 0, 0, height, x, 800 - y - height] });

test("chart labels are removed before reading order, keeping captions and nearby body intact", () => {
  const items = [item("Running header spanning the whole page", 40, 90, 520),
    item("GPU 0", 60, 120, 40), item("0.8", 50, 150, 20), item("Expert ID", 90, 205, 80),
    item("Figure 2. A chart.", 40, 220, 200), item("The caption continues here.", 40, 234, 210),
    item("Body text remains.", 40, 300), item("Right body remains.", 330, 120)];
  const page = orderTextItems(items, {}, viewport, { mode: "two", graphicRegions: [{ x: 40, y: 90, width: 200, height: 110 }] });
  expect(page.excludedFigureIndices).toEqual([1, 2, 3]);
  const text = page.blocks.map((block) => block.text).join(" ");
  expect(text).toContain("Figure 2. A chart.");
  expect(text).toContain("The caption continues here.");
  expect(text).toContain("Body text remains.");
  expect(text).toContain("Right body remains.");
  expect(text).toContain("Running header");
  expect(text).not.toMatch(/GPU 0|Expert ID/);
});

test("a multi-panel figure uses the whole caption line and connected panels before estimating body columns or font size", () => {
  const graphicRegions = [], labels = [];
  for (const y of [60, 152]) for (const x of [40, 200, 360]) {
    graphicRegions.push({ x, y, width: 190, height: 105 });
    labels.push(item("TTFT (s) 0.0 0.4 0.8", x + 15, y + 25, 140, 7));
  }
  const items = [...labels,
    item("Figure 8.", 100, 275, 40, 9), item("Throughput curves across all system setups.", 142, 275, 350, 9),
    item("Left body first.", 40, 320, 220), item("Left body second.", 40, 334, 220),
    item("Right body first.", 330, 320, 220), item("Right body second.", 330, 334, 220),
  ];
  const page = orderTextItems(items, {}, viewport, { graphicRegions });
  expect(page.excludedFigureIndices).toEqual([0, 1, 2, 3, 4, 5]);
  expect(page.mode).toBe("two");
  expect(page.blocks.map((block) => block.kind)).toEqual(["caption", "paragraph", "paragraph"]);
  expect(page.blocks.map((block) => block.text).join(" | ")).toBe(
    "Figure 8. Throughput curves across all system setups. | Left body first. Left body second. | Right body first. Right body second.");
  expect(graphicRegions).toHaveLength(6);
});

test("connected panels retain their shapes so body text in rectangular gaps is preserved", () => {
  const regions = [{ x: 300, y: 50, width: 250, height: 200 }, { x: 40, y: 220, width: 300, height: 100 }];
  const items = [item("Body text beside the top-right panel must remain.", 40, 100, 220),
    item("Top chart label", 350, 100, 100, 7), item("Bottom chart label", 60, 260, 100, 7),
    item("Body text beside the bottom-left panel must remain.", 350, 280, 210),
    item("Figure 1. Connected panels.", 40, 340, 510, 9)];
  const page = orderTextItems(items, {}, viewport, { graphicRegions: regions });
  expect(page.excludedFigureIndices).toEqual([1, 2]);
  const text = page.blocks.map((block) => block.text).join(" ");
  expect(text).toContain("Body text beside the top-right panel must remain.");
  expect(text).toContain("Body text beside the bottom-left panel must remain.");
  expect(text).toContain("Figure 1. Connected panels.");
});

test("caption extents stop at the column gap and cannot absorb prose alongside another figure", () => {
  const items = [item("Upper right chart label", 350, 100, 130, 7),
    item("Left chart label", 60, 200, 100, 7),
    item("Figure 4. A left-column chart.", 40, 250, 220, 9),
    item("Ordinary right-column discussion alongside the caption.", 278, 250, 260, 10),
    item("More right-column discussion below the caption.", 278, 265, 260, 10),
    item("Figure 6. Another right-column chart.", 278, 400, 260, 9),
  ];
  const page = orderTextItems(items, {}, viewport, { graphicRegions: [
    { x: 40, y: 150, width: 220, height: 90 }, { x: 278, y: 70, width: 260, height: 100 },
  ] });
  expect(page.excludedFigureIndices).toEqual([1]);
  expect(page.blocks.map((block) => block.text).join(" ")).toContain("Ordinary right-column discussion alongside the caption.");
  expect(page.blocks.map((block) => block.text).join(" ")).toContain("More right-column discussion below the caption.");
});
