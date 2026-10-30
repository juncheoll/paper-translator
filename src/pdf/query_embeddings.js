import { indexChunks } from "./document_index.js";

export async function embedPageQueries(blocks, embed, { signal, onProgress } = {}) {
  const queries = blocks.filter((block) => block.kind !== "formula" && /[\p{L}]/u.test(block.text || ""))
    .map((block) => ({ id: block.id, text: String(block.text).slice(0, 1200) }));
  const indexed = await indexChunks(queries, embed, { batchSize: 8, signal, onProgress });
  return new Map(indexed.map(({ id, vector }) => [id, vector]));
}
