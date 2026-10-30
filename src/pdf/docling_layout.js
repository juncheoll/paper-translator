import { loadDocumentState, saveDocumentState } from "./document_index";
import { doclingConfiguration, LOCAL_DOCLING_ENDPOINT } from "../services/docling_config.js";

const ENDPOINT = LOCAL_DOCLING_ENDPOINT;
const ADAPTER_VERSION = "docling-native-v1";
const labels = new Set(["text", "title", "section_header", "caption", "footnote", "page_header", "page_footer",
  "picture", "table", "formula", "list_item", "code", "document_index", "checkbox_selected", "checkbox_unselected", "form", "key_value_region"]);
const stopped = (signal) => { if (signal?.aborted) throw new DOMException("Stopped", "AbortError"); };
const startHelper = async options => (await import(/* webpackMode: "eager" */ "../docling_helper/client.js"))
  .requestDoclingHelper({ operation: "start" }, options);

export function validateDoclingLayout(value, documentId, pageCount) {
  if (value?.schema !== 1 || value.documentId !== documentId || !/^[a-f0-9]{64}$/.test(value.identity) ||
      !Array.isArray(value.pages) || value.pages.length !== pageCount) throw new Error("Invalid Docling document identity");
  for (const [i, page] of value.pages.entries()) {
    if (page.pageNumber !== i + 1 || ![page.width, page.height].every((n) => Number.isFinite(n) && n > 0 && n <= 20000) ||
        !Array.isArray(page.regions) || page.regions.length > 5000) throw new Error("Invalid Docling page");
    let cellCount = 0;
    const validBox = (box) => box && [box.x, box.y, box.width, box.height].every(Number.isFinite) &&
      box.width > 0 && box.height > 0 && box.x >= -page.width * 0.05 && box.y >= -page.height * 0.05 &&
      box.x + box.width <= page.width * 1.05 && box.y + box.height <= page.height * 1.05;
    const ids = new Set();
    for (const region of page.regions) {
      if (!Number.isInteger(region.id) || ids.has(region.id) || !labels.has(region.label) ||
          !Number.isFinite(region.confidence) || region.confidence < 0 || region.confidence > 1 || !validBox(region.bbox) ||
          !Array.isArray(region.cells) || !region.cells.every(validBox)) throw new Error("Invalid Docling region");
      ids.add(region.id);
      cellCount += region.cells.length;
    }
    if (cellCount > 20000) throw new Error("Too many Docling cells");
  }
  return value;
}

export function createDoclingLayoutClient({ pdfDocument, documentId, fetch: request,
  loadState = loadDocumentState, saveState = saveDocumentState, endpoint = ENDPOINT, settings,
  autoStart = true, ensureService = startHelper } = {}) {
  const configuration = settings ? doclingConfiguration(settings) : { execution: "local", endpoint };
  endpoint = configuration.endpoint;
  const cacheKey = `paper-pdf-docling:${documentId}:${endpoint}:layout-v1`;
  let memory;
  async function fetchJson(path, { signal, timeout = 3000, ...options } = {}) {
    stopped(signal);
    if (!request) {
      const { requestDoclingApi, stageDoclingUpload, discardDoclingUpload } =
        await import(/* webpackMode: "eager" */ "../services/docling_client.js");
      const operation = path === "/v1/info" ? "info" : options.method === "POST" ? "analyze" : "cache";
      let uploadId;
      try {
        if (operation === "analyze") uploadId = await stageDoclingUpload(options.body, { signal });
        return await requestDoclingApi({ operation, configuration,
          ...(operation !== "info" ? { documentId } : {}), ...(uploadId ? { uploadId } : {}) }, { signal });
      } finally { if (uploadId) await discardDoclingUpload(uploadId).catch(() => {}); }
    }
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, timeout);
    try {
      const response = await request(`${endpoint}${path}`, { ...options, signal: controller.signal, credentials: "omit" });
      if (response.status === 404) return null;
      if (!response.ok) throw new Error(`Docling HTTP ${response.status}`);
      return await response.json();
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  }
  return async ({ signal, onStatus = () => {} } = {}) => {
    stopped(signal);
    if (memory) return { ...memory, cache: "memory" };
    let cached;
    try {
      const saved = await loadState(cacheKey);
      if (saved) cached = validateDoclingLayout(saved, documentId, pdfDocument.numPages);
    } catch (_) { /* A damaged browser cache can be replaced from the service. */ }
    stopped(signal);
    try {
      onStatus("checking");
      let info;
      try { info = await fetchJson("/v1/info", { signal }); }
      catch (error) {
        stopped(signal);
        // Cached geometry needs no running model; starting never downloads missing weights.
        if (cached || !autoStart || configuration.execution !== "local") throw error;
        onStatus("starting");
        await ensureService({ signal });
        stopped(signal);
        info = await fetchJson("/v1/info", { signal });
      }
      if (info?.schema !== 1 || !/^[a-f0-9]{64}$/.test(info.identity) || info.config?.device !== "cpu" || info.config?.batch_size !== 1) {
        throw new Error("Invalid Docling service configuration");
      }
      if (cached?.identity === info.identity) {
        memory = { ...cached, cache: "browser", layoutIdentity: [ADAPTER_VERSION, cached.identity] };
        return memory;
      }
      onStatus("analyzing");
      let data = await fetchJson(`/v1/layout/${documentId}`, { signal });
      if (!data) {
        stopped(signal);
        const bytes = await pdfDocument.getData();
        stopped(signal);
        if (bytes.byteLength > 50 * 1024 * 1024) throw new Error("PDF exceeds the 50 MiB layout service limit");
        data = await fetchJson(`/v1/layout/${documentId}`, { signal, timeout: 250000,
          method: "POST", headers: { "Content-Type": "application/pdf" }, body: bytes });
      }
      stopped(signal);
      validateDoclingLayout(data, documentId, pdfDocument.numPages);
      if (data.identity !== info.identity) throw new Error("Docling service identity changed during analysis");
      await saveState(cacheKey, data).catch(() => {});
      stopped(signal);
      memory = { ...data, layoutIdentity: [ADAPTER_VERSION, data.identity] };
      return memory;
    } catch (error) {
      stopped(signal);
      if (cached) {
        memory = { ...cached, cache: "browser", warning: "cached-offline", layoutIdentity: [ADAPTER_VERSION, cached.identity] };
        return memory;
      }
      // Failed requests never replace a successful analysis or poison the native index cache.
      return { identity: null, pages: [], warning: "unavailable", error: error.message };
    }
  };
}
