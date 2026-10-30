import { embedPageQueries } from "../src/pdf/query_embeddings";

const prose = (count) => Array.from({ length: count }, (_, index) => ({
  id: `sentence-${index}`, text: `Sentence ${index}.`, kind: "paragraph",
}));

test('query embedding progress is reported while a page is waiting for translation', async () => {
  const onProgress=jest.fn();
  await embedPageQueries(prose(17),async texts=>texts.map(()=>[1,0]),{onProgress});
  expect(onProgress.mock.calls.map(([value])=>value)).toEqual([
    {completed:0,total:17},{completed:8,total:17},{completed:16,total:17},{completed:17,total:17},
  ]);
});

test("page queries are embedded eight at a time and mapped back to sentence IDs without altering source units", async () => {
  const blocks = prose(18);
  blocks[0].text += "x".repeat(1300);
  blocks.splice(2, 0, { id: "formula", text: "x = y", kind: "formula" }, { id: "numbers", text: "123 + 456" });
  const snapshot = structuredClone(blocks);
  let next = 0;
  let active = 0;
  let peak = 0;
  const embed = jest.fn(async (texts) => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    const embeddings = texts.map(() => [++next, 1]);
    return next <= 8 ? embeddings : { embeddings };
  });
  const result = await embedPageQueries(blocks, embed);
  expect(embed.mock.calls.map(([texts]) => texts.length)).toEqual([8, 8, 2]);
  expect(embed.mock.calls[0][0][0]).toHaveLength(1200);
  expect([...result.keys()]).toEqual(prose(18).map((block) => block.id));
  expect(result.get("sentence-8")).toEqual([9, 1]);
  expect(result.get("sentence-17")).toEqual([18, 1]);
  expect(peak).toBe(1);
  expect(blocks).toEqual(snapshot);
});

test("pages with only formulas and nonlinguistic text require no embedding requests", async () => {
  const embed = jest.fn();
  const result = await embedPageQueries([{ id: "formula", kind: "formula", text: "E = mc²" },
    { id: "number", text: "42" }, { id: "blank", text: "" }], embed);
  expect(result).toEqual(new Map());
  expect(embed).not.toHaveBeenCalled();
});

test("a response with missing queries is rejected instead of associating vectors with the wrong sentence", async () => {
  await expect(embedPageQueries(prose(2), async () => [[1, 0]])).rejects.toThrow(/count/);
});

test("embedding dimensions are checked across page batches", async () => {
  const embed = jest.fn().mockResolvedValueOnce(Array.from({ length: 8 }, () => [1, 0]))
    .mockResolvedValueOnce([[1]]);
  await expect(embedPageQueries(prose(9), embed)).rejects.toThrow(/dimension/);
});

test.each([[[0, 0]], [[NaN, 1]]])("invalid query vectors cannot be used for retrieval", async (vector) => {
  await expect(embedPageQueries(prose(1), async () => [vector])).rejects.toThrow(/Invalid/);
});

test("cancellation discards the pending batch and never schedules the rest of the page", async () => {
  const aborter = new AbortController();
  const embed = jest.fn(async (texts, { signal }) => {
    expect(signal).toBe(aborter.signal);
    aborter.abort();
    return texts.map(() => [1, 0]);
  });
  await expect(embedPageQueries(prose(9), embed, { signal: aborter.signal }))
    .rejects.toMatchObject({ name: "AbortError" });
  expect(embed).toHaveBeenCalledTimes(1);
});
