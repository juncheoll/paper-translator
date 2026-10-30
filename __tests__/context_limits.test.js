import { normalizeContextLimits } from "../src/context_limits";

test("missing settings retain the existing context sizes", () => {
  expect(normalizeContextLimits()).toEqual({
    title: 300, heading: 250, paragraph: 2400, before: 450, after: 450, total: 4000,
  });
});

test("imported settings are bounded integers, with zero preserved", () => {
  expect(normalizeContextLimits({
    llmContextTitleLimit: "0", llmContextHeadingLimit: "125.9",
    llmContextParagraphLimit: -15, llmContextBeforeLimit: 99999,
    llmContextAfterLimit: "invalid", llmContextTotalLimit: "",
  })).toEqual({ title: 0, heading: 125, paragraph: 0, before: 12000, after: 450, total: 4000 });
});
