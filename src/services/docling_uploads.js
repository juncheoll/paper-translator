import { MAX_DOCLING_BYTES } from './docling_config.js';

const DATABASE = 'paper-docling-transfers', STORE = 'uploads', MAX_AGE = 10 * 60 * 1000;
const validId = value => typeof value === 'string' && /^[a-f0-9-]{36}$/.test(value);
export const isFreshDoclingUpload = (createdAt, now = Date.now()) => Number.isFinite(createdAt) &&
  createdAt > 0 && createdAt <= now && now - createdAt <= MAX_AGE;
let opening;
function database() {
  if (opening) return opening;
  opening = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE, 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE, { keyPath: 'id' });
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => { db.close(); opening = null; };
      resolve(db);
    };
    request.onerror = () => { opening = null; reject(request.error); };
  });
  return opening;
}
async function transaction(callback) {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = tx.onabort = () => reject(tx.error || new Error('Docling 파일 전달을 저장하지 못했습니다.'));
    callback(tx.objectStore(STORE), value => { result = value; });
  });
}

export async function purgeDoclingUploads() {
  return transaction(store => {
    const cursor = store.openCursor();
    cursor.onsuccess = () => {
      const entry = cursor.result;
      if (!entry) return;
      if (!isFreshDoclingUpload(entry.value.createdAt)) entry.delete();
      entry.continue();
    };
  });
}

// PDF bytes stay in extension storage; Chrome runtime messages carry only a random transfer ID.
export async function stageDoclingUpload(bytes, { signal } = {}) {
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  const blob = bytes instanceof Blob ? bytes : new Blob([bytes], { type: 'application/pdf' });
  if (!blob.size || blob.size > MAX_DOCLING_BYTES) throw new Error('Docling은 최대 50 MiB의 PDF를 분석합니다.');
  await purgeDoclingUploads();
  const id = crypto.randomUUID();
  await transaction(store => {
    const count = store.count();
    count.onsuccess = () => {
      if (count.result >= 4) store.transaction.abort();
      else store.put({ id, blob, createdAt: Date.now() });
    };
  });
  if (signal?.aborted) { await discardDoclingUpload(id); throw new DOMException('Stopped', 'AbortError'); }
  return id;
}

export async function discardDoclingUpload(id) {
  if (!validId(id)) return;
  await transaction(store => store.delete(id));
}

export async function takeDoclingUpload(id) {
  if (!validId(id)) throw new Error('Invalid Docling upload ID.');
  const record = await transaction((store, setResult) => {
    const request = store.get(id);
    request.onsuccess = () => { setResult(request.result); store.delete(id); };
  });
  if (!record || !isFreshDoclingUpload(record.createdAt) || typeof record.blob?.arrayBuffer !== 'function' ||
      !record.blob.size || record.blob.size > MAX_DOCLING_BYTES) throw new Error('Docling PDF 전달이 만료되었습니다. 다시 시도하세요.');
  return record.blob;
}
