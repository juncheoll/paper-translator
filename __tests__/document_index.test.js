import {
  chunkDocumentPages, indexChunks, retrieveRelatedChunks,
  loadDocumentState, saveDocumentState, deleteDocumentState,
} from "../src/pdf/document_index";

test("retrieval chunking covers every source character without merging ordered blocks", () => {
  const text = "A sentence about a biological cell. ".repeat(20).trim();
  const pages = [{ pageNumber: 3, blocks: [
    { id: "p3-b0", text, kind: "paragraph", column: 1 },
    { id: "p3-b1", text: "Figure 1: A cell.", kind: "caption", column: 2 },
  ] }];
  const chunks = chunkDocumentPages(pages, { maxChars: 100, overlapChars: 20 });
  const parts = chunks.filter((chunk) => chunk.blockIds[0] === "p3-b0");
  expect(parts.length).toBeGreaterThan(1);
  const covered = new Array(text.length).fill(false);
  for (const part of parts) {
    expect(part.text.length).toBeLessThanOrEqual(100);
    expect(part.pageNumber).toBe(3);
    for (let i = part.start; i < part.end; i++) covered[i] = true;
  }
  expect(covered.every(Boolean)).toBe(true);
  expect(parts[1].start).toBeLessThan(parts[0].end);
  expect(chunks.at(-1)).toMatchObject({ blockIds: ["p3-b1"], kind: "caption", text: "Figure 1: A cell." });
  expect(pages[0].blocks).toHaveLength(2);
  expect(pages[0].blocks[0].text).toBe(text);
});

test("indexing batches sequentially and reports completion only after validated responses", async () => {
  const chunks = Array.from({ length: 5 }, (_, i) => ({ id: String(i), text: `text${i}` }));
  let active = 0;
  let peak = 0;
  const embed = jest.fn(async (texts) => {
    active++;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active--;
    return { embeddings: texts.map(() => [1, 0]) };
  });
  const progress = jest.fn();
  const result = await indexChunks(chunks, embed, { batchSize: 2, onProgress: progress });
  expect(embed.mock.calls.map(([texts]) => texts.length)).toEqual([2, 2, 1]);
  expect(peak).toBe(1);
  expect(progress.mock.calls.map(([value]) => value.completed)).toEqual([0, 2, 4, 5]);
  expect(result).toHaveLength(5);
  expect(chunks[0]).not.toHaveProperty("vector");
});

test.each([
  [[[1, 0]], "count"],
  [[[1, 0], [1]], "dimension"],
  [[[1, 0], [0, 0]], "Invalid"],
  [[[1, 0], [NaN, 1]], "Invalid"],
])("invalid model embeddings cannot mark the index complete", async (vectors, error) => {
  const progress = jest.fn();
  await expect(indexChunks([{ text: "a" }, { text: "b" }], async () => vectors, { onProgress: progress }))
    .rejects.toThrow(new RegExp(error, "i"));
  expect(progress).toHaveBeenCalledTimes(1);
});

test("cancellation during inference stops before committing a completed batch", async () => {
  const controller = new AbortController();
  const progress = jest.fn();
  await expect(indexChunks([{ text: "a" }], async () => {
    controller.abort();
    return [[1, 0]];
  }, { signal: controller.signal, onProgress: progress })).rejects.toMatchObject({ name: "AbortError" });
  expect(progress).toHaveBeenCalledTimes(1);
});

const index = [
  { id: "same", blockIds: ["target"], text: "Current paragraph", vector: [1, 0] },
  { id: "a", blockIds: ["other"], text: "Related reference", vector: [0.9, 0.1] },
  { id: "a-overlap", blockIds: ["other"], text: "Overlapping reference", vector: [0.8, 0.2] },
  { id: "b", blockIds: ["next"], text: "Another reference", vector: [0.6, 0.4] },
  { id: "c", blockIds: ["unrelated"], text: "Unrelated reference", vector: [0, 1] },
];

test("retrieval excludes the target and repeated overlapping blocks within the text budget", () => {
  const result = retrieveRelatedChunks(index, [1, 0], { excludeBlockIds: ["target"], maxChars: 22 });
  expect(result.map((chunk) => chunk.id)).toEqual(["a", "b"]);
  expect(result.reduce((count, chunk) => count + chunk.text.length, 0)).toBe(22);
  expect(result[0].score).toBeGreaterThan(result[1].score);
  expect(index[3].text).toBe("Another reference");
});

test("incompatible cached embeddings fail clearly instead of producing arbitrary matches", () => {
  expect(() => retrieveRelatedChunks(index, [1, 0, 0])).toThrow(/dimension/);
  expect(() => retrieveRelatedChunks(index, [0, 0])).toThrow(/Invalid/);
  expect(retrieveRelatedChunks(index, [1, 0], { limit: 0 })).toEqual([]);
});

test("memory fallback keeps document and configuration keys separate and snapshots isolated", async () => {
  const firstId = "paper:model-A:ko:auto";
  const secondId = "paper:model-B:ko:auto";
  const state = { translations: { b1: "translation" }, index: [{ vector: [1, 0] }] };
  expect(await saveDocumentState(firstId, state)).toBe(false);
  state.translations.b1 = "changed caller";
  const loaded = await loadDocumentState(firstId);
  expect(loaded.translations.b1).toBe("translation");
  loaded.translations.b1 = "changed reader";
  expect((await loadDocumentState(firstId)).translations.b1).toBe("translation");
  expect(await loadDocumentState(secondId)).toBeNull();
  await deleteDocumentState(firstId);
  expect(await loadDocumentState(firstId)).toBeNull();
});
