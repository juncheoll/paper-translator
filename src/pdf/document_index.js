const cleanText = (text) => String(text || "").replace(/\s+/g, " ").trim();

// Retrieval chunks overlap; translation targets remain the original ordered blocks.
export function chunkDocumentPages(pages, { maxChars = 1400, overlapChars = 160 } = {}) {
  if (!Array.isArray(pages)) throw new TypeError("PDF pages must be an array");
  maxChars = Math.max(1, Math.floor(Number(maxChars) || 1400));
  overlapChars = Math.max(0, Math.min(maxChars - 1, Math.floor(Number(overlapChars) || 0)));
  const chunks = [];
  for (const [pageIndex, page] of pages.entries()) {
    const pageNumber = Number(page.pageNumber) || pageIndex + 1;
    for (const [blockIndex, block] of (page.blocks || []).entries()) {
      if (block.visualRegion) continue;
      const text = cleanText(block.text);
      const blockId = block.id || `p${pageNumber}-b${blockIndex}`;
      let start = 0;
      let part = 0;
      while (start < text.length) {
        let end = Math.min(text.length, start + maxChars);
        if (end < text.length) {
          const candidate = text.slice(start, end);
          const boundaries = [...candidate.matchAll(/[.!?](?:\s|$)|\s/g)];
          const boundary = boundaries.at(-1);
          if (boundary && boundary.index >= maxChars / 2) end = start + boundary.index + boundary[0].length;
        }
        chunks.push({
          id: `${blockId}-c${part++}`,
          pageNumber,
          blockIds: [blockId],
          kind: block.kind || "paragraph",
          text: text.slice(start, end).trim(),
          start,
          end,
        });
        if (end === text.length) break;
        start = Math.max(start + 1, end - overlapChars);
      }
    }
  }
  return chunks;
}

function checkAborted(signal) {
  if (signal?.aborted) {
    const error = new Error("PDF indexing cancelled");
    error.name = "AbortError";
    throw error;
  }
}

function vectorNorm(vector, dimension) {
  if (!Array.isArray(vector) || !vector.length ||
      (dimension != null && vector.length !== dimension)) {
    throw new Error("Embedding dimension mismatch");
  }
  let squared = 0;
  for (const value of vector) {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error("Invalid embedding vector");
    squared += value * value;
  }
  if (!Number.isFinite(squared) || squared <= 0) throw new Error("Invalid embedding vector");
  return Math.sqrt(squared);
}

export async function indexChunks(chunks, embed, { batchSize = 8, onProgress = () => {}, signal } = {}) {
  if (!Array.isArray(chunks) || typeof embed !== "function") throw new TypeError("PDF chunks and embed function are required");
  batchSize = Math.max(1, Math.min(32, Math.floor(Number(batchSize) || 8)));
  const indexed = [];
  let dimension;
  checkAborted(signal);
  onProgress({ completed: 0, total: chunks.length });
  for (let start = 0; start < chunks.length; start += batchSize) {
    checkAborted(signal);
    const batch = chunks.slice(start, start + batchSize);
    const response = await embed(batch.map((chunk) => chunk.text), { signal });
    checkAborted(signal);
    const vectors = Array.isArray(response) ? response : response?.embeddings;
    if (!Array.isArray(vectors) || vectors.length !== batch.length) throw new Error("Embedding response count mismatch");
    for (const [index, chunk] of batch.entries()) {
      vectorNorm(vectors[index], dimension);
      dimension ??= vectors[index].length;
      indexed.push({ ...chunk, vector: vectors[index].slice() });
    }
    onProgress({ completed: indexed.length, total: chunks.length });
  }
  return indexed;
}

export function retrieveRelatedChunks(index, queryVector, {
  excludeIds = [], excludeBlockIds = [], limit = 3, maxChars = 2200,
} = {}) {
  limit = Math.max(0, Math.floor(Number(limit) || 0));
  maxChars = Math.max(0, Math.floor(Number(maxChars) || 0));
  if (!limit || !maxChars || !index?.length) return [];
  const queryNorm = vectorNorm(queryVector);
  const excluded = new Set(excludeIds);
  const excludedBlocks = new Set(excludeBlockIds);
  const ranked = index.map((chunk, order) => {
    const norm = vectorNorm(chunk.vector, queryVector.length);
    const dot = chunk.vector.reduce((sum, value, i) => sum + value * queryVector[i], 0);
    return { ...chunk, score: dot / (norm * queryNorm), order };
  }).filter((chunk) => !excluded.has(chunk.id) &&
    !(chunk.blockIds || []).some((id) => excluded.has(id) || excludedBlocks.has(id)))
    .sort((a, b) => b.score - a.score || a.order - b.order);
  const selected = [];
  const usedBlocks = new Set();
  let remaining = maxChars;
  for (const chunk of ranked) {
    if ((chunk.blockIds || []).some((id) => usedBlocks.has(id))) continue;
    const text = chunk.text.slice(0, remaining);
    if (!text) continue;
    const { order, ...source } = chunk;
    selected.push({ ...source, text });
    for (const id of chunk.blockIds || []) usedBlocks.add(id);
    remaining -= text.length;
    if (selected.length >= limit || remaining <= 0) break;
  }
  return selected;
}

const memoryStates = new Map();
let databasePromise;
const clone = (value) => typeof structuredClone === "function"
  ? structuredClone(value) : JSON.parse(JSON.stringify(value));

function openDatabase() {
  if (typeof indexedDB === "undefined") return Promise.resolve(null);
  if (!databasePromise) {
    databasePromise = new Promise((resolve) => {
      let request;
      try { request = indexedDB.open("mtt-pdf-translation", 1); }
      catch (_) { resolve(null); return; }
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains("documents")) request.result.createObjectStore("documents");
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => resolve(null);
      request.onblocked = () => resolve(null);
    });
  }
  return databasePromise;
}

export async function loadDocumentState(documentId) {
  if (memoryStates.has(documentId)) return clone(memoryStates.get(documentId));
  const database = await openDatabase();
  if (!database) return null;
  try {
    const state = await new Promise((resolve, reject) => {
      const request = database.transaction("documents", "readonly").objectStore("documents").get(documentId);
      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
    if (state) memoryStates.set(documentId, clone(state));
    return state;
  } catch (_) { return null; }
}

// Return whether the snapshot reached persistent storage; memory still supports this open document.
export async function saveDocumentState(documentId, state) {
  const snapshot = clone(state);
  memoryStates.set(documentId, snapshot);
  const database = await openDatabase();
  if (!database) return false;
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("documents", "readwrite");
      transaction.objectStore("documents").put(snapshot, documentId);
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    return true;
  } catch (_) { return false; }
}

export async function deleteDocumentState(documentId) {
  memoryStates.delete(documentId);
  const database = await openDatabase();
  if (!database) return;
  await new Promise((resolve, reject) => {
    const transaction = database.transaction("documents", "readwrite");
    transaction.objectStore("documents").delete(documentId);
    transaction.oncomplete = resolve;
    transaction.onerror = () => reject(transaction.error);
    transaction.onabort = () => reject(transaction.error);
  });
}
