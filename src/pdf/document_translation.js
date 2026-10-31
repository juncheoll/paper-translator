import browser from "webextension-polyfill";
import localLlm from "../services/translation.js";
import { loadSettings } from "../settings.js";
import { loadUiLanguage, getMessage } from "../i18n.js";
import { normalizeContextLimits } from "../context_limits.js";
import { extractOrderedPage } from "./reading_order";
import { createDocumentSentencePages, normalizeSentenceText } from "./sentences";
import { filterDocumentBody } from "./document_body";
import { createPdfTranslationPanel } from "./translation_panel";
import { translateSentencePart } from "./sentence_translation";
import { createPdfSourceHighlighter } from "./source_highlight";
import { createPdfSourceHover } from "./source_hover";
import { embedPageQueries } from "./query_embeddings";
import { getDisplayParagraphs, getDisplaySections } from "./display_paragraphs";
import { createDoclingLayoutClient } from "./docling_layout";
import { createPdfLayoutOverlay } from "./layout_overlay";
import { createRegionEditStore } from "./layout_edits";
import { createPdfRegionEditor } from "./region_editor";
import { createPdfRegionGeometryEditor } from "./region_geometry";
import { createPdfVisualRenderer } from "./visual_regions";
import { findVariableEvidence } from "./formula_variables";
import { createPdfFormulaHover } from "./formula_hover";
import { protectedMathText, validMathTranslation, mathTranslationError, plainMathText } from "./inline_math";
import { requestBrowserAi } from "../browser_ai/client.js";
import { requestPdfApi } from "./api_client.js";
import { requireLlmEndpoint, ollamaApiUrl, embedWithOllama, fetchOllamaModelIdentity } from "./ollama_api.js";
export { requireLlmEndpoint, ollamaApiUrl, fetchOllamaModelIdentity } from "./ollama_api.js";
import { BROWSER_TRANSLATION_MODEL, getBrowserModelIdentity } from "../browser_ai/models.js";
import {
  chunkDocumentPages, indexChunks, retrieveRelatedChunks,
  loadDocumentState, saveDocumentState,
} from "./document_index";

const EMBEDDING_MODEL = "embeddinggemma";
const CACHE_VERSION = 12;
const TRANSLATION_VERSION = "sentences-v4";
const msg = (key, fallback) => getMessage(key) || fallback;

export function formatPdfTranslationError(error) {
  if (error?.status === 403) return msg("PDF_Server_Access_Denied",
    "서버가 접근을 거부했습니다 (HTTP 403). 서버의 인증·접속 허용 설정을 확인하세요.");
  const messages = {
    OUTPUT_LIMIT: ["PDF_Translation_Error_Output_Limit", "출력 한도에 도달해 번역을 완료하지 못했습니다."],
    TIMEOUT: ["PDF_Translation_Error_Timeout", "로컬 번역 응답 시간이 초과되었습니다."],
    CONNECTION_ERROR: ["PDF_Translation_Error_Connection", "로컬 번역 서버에 연결하지 못했습니다. Ollama 실행 상태를 확인하세요."],
    HTTP_ERROR: ["PDF_Translation_Error_HTTP", "로컬 번역 서버 오류"],
    EMPTY_OUTPUT: ["PDF_Translation_Error_Empty", "모델이 빈 번역 결과를 반환했습니다."],
    INVALID_RESPONSE: ["PDF_Translation_Error_Invalid_Response", "로컬 번역 서버의 응답 형식이 올바르지 않습니다."],
    CONFIGURATION: ["PDF_Translation_Error_Configuration", "로컬 번역 모델과 서버 주소를 확인하세요."],
    CONTENT_FILTER: ["PDF_Translation_Error_Content_Filter", "모델이 이 문장의 번역을 제공하지 않았습니다."],
    MATH_PLACEHOLDER: ["PDF_Translation_Error_Math", "번역에서 수학 기호가 누락되거나 바뀌었습니다. 이 문장을 다시 번역해 주세요."],
    PDF_API_DISCONNECTED: ["PDF_API_Disconnected", "확장 백그라운드 연결이 끊겼습니다. 확장프로그램과 PDF 탭을 새로고침한 뒤 다시 시도하세요."],
    PDF_API_PERMISSION: ["PDF_API_Permission", "확장프로그램에 LLM 서버 접근 권한이 없습니다. 확장 상세 설정의 사이트 액세스 권한을 확인하세요."],
    PDF_API_CONFIG_CHANGED: ["PDF_API_Config_Changed", "LLM 설정이 변경되었습니다. 현재 작업을 중지하고 다시 번역해 주세요."],
    PDF_API_REQUEST: ["PDF_API_Invalid_Request", "PDF API 요청 형식이 올바르지 않습니다. 확장프로그램과 PDF 탭을 새로고침하세요."],
    PDF_API_TIMEOUT: ["PDF_API_Timeout", "확장 백그라운드의 서버 요청 시간이 초과되었습니다. 다시 시도하세요."],
    BROWSER_MODEL_NOT_READY: ["Browser_AI_Prepare_Required", "설정의 브라우저 모델에서 번역 모델과 RAG 임베딩 모델을 먼저 다운로드·준비해 주세요."],
    BROWSER_GPU_UNAVAILABLE: ["Browser_AI_GPU_Unavailable", "WebGPU를 사용할 수 없습니다. 하드웨어 가속을 확인하거나 API 실행을 선택하세요."],
  };
  const entry = messages[error?.code];
  if (!entry) return error?.message || msg("PDF_Block_Translation_Failed", "문장 번역에 실패했습니다. 다시 페이지 번역을 눌러 재시도하세요.");
  return msg(...entry) + (error.code === "HTTP_ERROR" && error.status ? ` (HTTP ${error.status})` : "");
}

// PDF fingerprints can use only an initial byte range; cache against the complete file.
export async function getDocumentCacheId(pdfDocument) {
  const bytes = await pdfDocument.getData();
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// Byte count is a conservative input-token bound, leaving room for instructions and output.
export function fitReferenceContext(context, source, maxBytes = 6000) {
  const encoder = new TextEncoder();
  let remaining = Math.max(0, maxBytes - encoder.encode(source).length);
  let output = "";
  for (const char of context) {
    const size = encoder.encode(char).length;
    if (size > remaining) break;
    output += char;
    remaining -= size;
  }
  return output;
}

function cancelled(signal) {
  if (signal?.aborted) throw new DOMException("Stopped", "AbortError");
}

export function splitTranslationText(text, maxChars = 900) {
  const parts = [];
  let rest = String(text || "").trim();
  while (rest) {
    if (rest.length <= maxChars) { parts.push(rest); break; }
    const window = rest.slice(0, maxChars + 1);
    const sentence = [...window.matchAll(/[.!?。！？]\s+/g)]
      .filter((match) => match.index > maxChars / 2).pop();
    const boundary = sentence ? sentence.index + sentence[0].length : window.lastIndexOf(" ");
    let end = boundary > maxChars / 3 ? boundary : maxChars;
    const open = rest.lastIndexOf('[', end - 1), close = open >= 0 ? rest.indexOf(']', open) : -1;
    if (open >= 0 && close >= end && close - open < 32) end = open > maxChars / 3 ? open : close + 1;
    parts.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  return parts;
}

export function makePageReference(page, block, related, title, abstract, settings, pages = []) {
  const limit = normalizeContextLimits(settings);
  if (!limit.total) return "";
  const sourceIds = new Set(block.sourceBlockIds || [block.id]);
  const allBlocks = (pages.length ? pages : [page]).flatMap((item) => item.blocks).filter((item) => !item.visualRegion);
  const index = allBlocks.findIndex((item) => sourceIds.has(item.id));
  const lastIndex = allBlocks.findLastIndex((item) => sourceIds.has(item.id));
  const heading = allBlocks.slice(0, index).filter((item) => item.kind === "heading").pop();
  const previous = allBlocks[index - 1];
  const following = allBlocks[lastIndex + 1];
  const parts = [];
  const add = (label, text, max) => {
    if (max > 0 && text) parts.push(`${label}: ${String(text).slice(0, max)}`);
  };
  add("Document title", title, limit.title);
  add("Section", heading?.text, limit.heading);
  if (block.unitType === "sentence") {
    const paragraph = normalizeSentenceText(allBlocks.filter((item) => sourceIds.has(item.id)).map((item) => item.text).join("\n"));
    const position = Math.max(0, paragraph.indexOf(block.text));
    const start = Math.max(0, position - Math.max(0, Math.floor((limit.paragraph - block.text.length) / 2)));
    add("Surrounding paragraph", paragraph.slice(start), limit.paragraph);
  }
  add("Previous paragraph", previous?.text, limit.before);
  add("Following paragraph", following?.text, limit.after);
  add("Abstract", abstract, Math.min(600, limit.paragraph));
  for (const chunk of related) {
    add(`Related source, page ${chunk.pageNumber}`, chunk.text, Math.min(1000, limit.paragraph));
  }
  return parts.join("\n").slice(0, limit.total);
}

// Standalone extraction checks have no extension runtime; installed viewers always use the broker.
async function requestServerApi(operation, data, settings, { signal, temperature, seed, preserveMath } = {}) {
  const service = operation === "embed" ? "embedding" : data.service || "translation";
  const configuration = service === "embedding"
    ? { endpoint: settings.embeddingApiEndpoint, model: settings.embeddingModel, type: settings.embeddingApiType || "ollama" }
    : { endpoint: settings.llmApiEndpoint, model: settings.llmModel };
  try {
  if (browser.runtime?.connect) return await requestPdfApi({ operation, ...data,
    configuration,
    ...(operation === "translate" ? { options: { temperature, seed, preserveMath } } :
      operation === "translateBatch" ? { options: { preserveMath } } : {}) }, { signal });
  if (operation === "embed") return await embedWithOllama(data.input, settings, { signal });
  if (operation === "modelIdentity") return await fetchOllamaModelIdentity(settings, { signal, service });
  if (operation === "translate") return await localLlm.translateStrict(data.text, "auto", data.target, settings, data.context,
    { signal, temperature, seed, preserveMath, sentenceOnly: true });
  return await localLlm.translateBatchStrict(data.entries, "auto", data.target, settings, data.context, { signal, preserveMath });
  } catch (error) { error.service = service; throw error; }
}

// The UI uses sentence units; only unusually long sentences need smaller generation segments.
export function createPdfTranslationController({
  pdfDocument, panel, settings, documentId, title = "", modelIdentity = "", embeddingModelIdentity = "",
  getCurrentPage = () => 1, readPage = extractOrderedPage,
  embed = (input, options) => settings.embeddingExecution === "browser"
    ? requestBrowserAi({ operation: "embed", input, purpose: options?.purpose || "document" }, options)
    : requestServerApi("embed", { input }, settings, options), loadLayout = null,
  // Page translation has its own cache and never needs tooltip dictionaries or engine fallback.
  translate = (text, target, context, options) => settings.llmExecution === "browser"
    ? localLlm.translateStrict(text, "auto", target, settings, context, { ...options, sentenceOnly: true })
    : requestServerApi("translate", { text, target, context }, settings, options),
  translateBatch = (entries, target, context, options) => settings.llmExecution === "browser"
    ? localLlm.translateBatchStrict(entries, "auto", target, settings, context, options)
    : requestServerApi("translateBatch", { entries, target, context }, settings, options),
  loadState = loadDocumentState, saveState = saveDocumentState,
}) {
  const browserExecution = settings.llmExecution === "browser";
  const embeddingBrowser = settings.embeddingExecution === "browser";
  if (browserExecution) modelIdentity = getBrowserModelIdentity().filter(([name]) => name === BROWSER_TRANSLATION_MODEL);
  if (embeddingBrowser) embeddingModelIdentity = getBrowserModelIdentity().filter(([name]) => name === EMBEDDING_MODEL);
  const queryEmbed = embeddingBrowser ? (input, options) => embed(input, { ...options, purpose: "query" }) : embed;
  let pages = [];
  let translationPages = [];
  let index = [];
  let translations = {};
  let modes = {};
  let key = "";
  let ready = false;
  let generation = 0;
  let active = null;
  let destroyed = false;
  let retrying = null;
  let replacementWrite = false;
  let displayedPage = null;
  let pageViewRequest = 0, previewRequest = 0;
  let abstract = "";
  let layout = null;
  let reusableResults = null, reusableIndex = [];
  let batchEnabled = typeof translateBatch === "function";
  const queryVectors = new Map();
  const displayParagraphs = new Map();
  const displayLoading = new Map();
  let sectionSource, displaySections = new Map();
  const target = settings.translateTarget || "ko";
  const preferencesKey = `mtt-pdf:${documentId}:layout`;
  const ownerOf = (unit, pageNumber) => unit.ownerPageNumber || pageNumber;
  const resultOf = (unit, pageNumber) => translations[ownerOf(unit, pageNumber)]?.[unit.id];
  const setResult = (unit, pageNumber, result) => {
    const owner = ownerOf(unit, pageNumber);
    translations[owner] ||= {};
    translations[owner][unit.id] = result;
  };

  const render = () => {
    if (sectionSource !== translationPages) {
      displaySections = getDisplaySections(translationPages); sectionSource = translationPages;
    }
    const n = displayedPage ?? getCurrentPage();
    const page = translationPages.find((item) => item.pageNumber === n);
    const groups = page && (displayParagraphs.get(n) || getDisplayParagraphs(page));
    panel.showPage({ pageNumber: n, blocks: (page?.blocks || []).map((unit) => ({ ...unit,
      displayParagraphId: groups.get(unit.id), displaySection: displaySections.get(unit.id) })),
      translations: Object.fromEntries((page?.blocks || []).filter((unit) => resultOf(unit, n) || retrying?.id === unit.id)
        .map((unit) => [unit.id, retrying?.id === unit.id ? { ...resultOf(unit, n), retranslating: true } : resultOf(unit, n)])), warnings: page?.warnings || [],
      mode: modes[n] || "auto" });
  };
  const pageKey = (n) => `${key}:page:${n}`;
  const needsTranslation = (block) => !["formula", "table"].includes(block.kind) && /[\p{L}]/u.test(block.text);
  const sourceIdentity = (unit, pageNumber) => JSON.stringify([unit.kind, unit.text,
    unit.sourceRanges?.length ? unit.sourceRanges.map((range) => [range.pageNumber ?? ownerOf(unit, pageNumber),
      range.itemIndex, range.start, range.end]) : [ownerOf(unit, pageNumber), unit.id],
    ...(unit.inlineMath?.length ? [unit.inlineMath.map(m => [m.start, m.end, m.visualRegion])] : [])]);

  async function restoreUnchangedResults(signal) {
    if (!reusableResults) return;
    const changed = new Set();
    for (const page of translationPages) {
      await loadPageTranslations(page, signal);
      cancelled(signal);
      for (const unit of page.blocks) {
        const previous = reusableResults.get(sourceIdentity(unit, page.pageNumber));
        if (previous && resultOf(unit, page.pageNumber)?.status !== "done") {
          setResult(unit, page.pageNumber, previous); changed.add(ownerOf(unit, page.pageNumber));
        }
      }
    }
    for (const owner of changed) {
      cancelled(signal);
      await saveState(pageKey(owner), { translations: translations[owner] });
    }
  }

  function referenceFor(sourcePage, blocks) {
    const sourceBlockIds = [...new Set(blocks.flatMap((block) => block.sourceBlockIds || [block.id]))];
    const vectors = blocks.map((block) => queryVectors.get(block.id)).filter(Boolean);
    const query = vectors.length ? vectors[0].map((_, i) =>
      vectors.reduce((sum, vector) => sum + vector[i], 0) / vectors.length) : [];
    const related = query.some((value) => value !== 0)
      ? retrieveRelatedChunks(index, query, { excludeBlockIds: sourceBlockIds, limit: 3, maxChars: 2200 }) : [];
    return makePageReference(sourcePage, { ...blocks[0], sourceBlockIds,
      text: blocks.map((block) => block.text).join(" ") }, related, title, abstract, settings, pages);
  }

  function reducedReference(block) {
    const limit = normalizeContextLimits(settings);
    const units = [...new Map(translationPages.flatMap((page) => page.blocks)
      .filter((unit) => (unit.unitType === "sentence" || unit.kind === "heading") && unit.kind === block.kind)
      .map((unit) => [unit.id, unit])).values()];
    const position = units.findIndex((unit) => unit.id === block.id);
    const label = block.kind === "heading" ? "heading" : "sentence";
    return [["Document title", title, limit.title], [`Previous ${label}`, units[position - 1]?.text, limit.before],
      [`Following ${label}`, units[position + 1]?.text, limit.after]]
      .filter(([, value, max]) => value && max > 0).map(([label, value, max]) => `${label}: ${value.slice(0, max)}`)
      .join("\n").slice(0, limit.total);
  }

  async function translateOne(block, context, signal, sampling = {}) {
    if (!needsTranslation(block)) return { status: "done", text: block.text };
    const results = [];
    let contextReduced = false;
    for (const part of splitTranslationText(protectedMathText(block))) {
      cancelled(signal);
      const math = (block.inlineMath || []).filter(m => part.includes(m.token));
      const checkedTranslate = async (...args) => {
        const result = await translate(...args);
        if (!validMathTranslation(result?.targetText, { inlineMath: math })) throw mathTranslationError();
        return result;
      };
      const response = await translateSentencePart(part, target, fitReferenceContext(context, part), checkedTranslate,
        { signal, ...sampling, ...(math.length ? { preserveMath: true } : {}) });
      cancelled(signal);
      contextReduced ||= response.contextReduced;
      results.push(response.targetText);
    }
    return { status: "done", text: results.join(" "),
      ...(contextReduced ? { notice: msg("PDF_Translation_Context_Reduced", "출력 실패 후 주변 문맥 없이 다시 번역했습니다.") } : {}) };
  }

  async function replaceSentenceResult(block, n, result, signal) {
    const owner = ownerOf(block, n), cache = pageKey(owner);
    const previous = translations[owner] || {};
    const updated = { ...previous, [block.id]: result };
    // Keep replacement writes exclusive until a cancelled write has restored the old snapshot.
    replacementWrite = true;
    try {
      await saveState(cache, { translations: updated });
      cancelled(signal);
      translations[owner] = updated;
    } catch (error) {
      await saveState(cache, { translations: previous }).catch(() => {});
      throw error;
    } finally { replacementWrite = false; }
    render();
  }

  async function prepare(signal) {
    if (ready) return;
    if (!browserExecution) {
      requireLlmEndpoint(settings.llmApiEndpoint);
      if (!settings.llmModel) throw new Error(msg("PDF_Local_Model_Required", "로컬 번역 모델을 선택해 주세요."));
    }
    const preferences = await loadState(preferencesKey);
    cancelled(signal);
    modes = preferences?.modes || modes;
    const embeddingIdentity = embeddingModelIdentity;
    const embeddingSource = embeddingBrowser
      ? ["wllama", EMBEDDING_MODEL]
      : [settings.embeddingApiType || "ollama", settings.embeddingApiEndpoint, settings.embeddingModel];
    if (loadLayout) {
      layout = await loadLayout({ signal, onStatus: phase =>
        panel.setStatus(phase === "starting" ? msg("Docling_Helper_Starting", "Docling을 시작하고 있습니다.") :
          msg("PDF_Analyzing_Docling", "Docling으로 문서 영역을 분석하고 있습니다 (CPU).")) });
      cancelled(signal);
    }
    const indexKey = JSON.stringify(["mtt-pdf", CACHE_VERSION, documentId,
      embeddingSource, embeddingIdentity, modes,
      ...(layout?.layoutIdentity ? [layout.layoutIdentity] : [])]);
    key = JSON.stringify([indexKey, TRANSLATION_VERSION, modelIdentity,
      browserExecution ? "wllama" : settings.llmApiEndpoint, browserExecution ? BROWSER_TRANSLATION_MODEL : settings.llmModel,
      target, normalizeContextLimits(settings)]);
    const cached = await loadState(indexKey);
    cancelled(signal);
    if (cached?.version === CACHE_VERSION && Array.isArray(cached.pages) &&
        cached.pages.length === pdfDocument.numPages && Array.isArray(cached.index)) {
      pages = cached.pages;
      translationPages = createDocumentSentencePages(pages);
      index = cached.index;
      abstract = cached.abstract || "";
      await restoreUnchangedResults(signal);
    } else {
      // Reparse older layouts while carrying over translations and vectors for unchanged native text.
      if (!reusableResults) {
        const previousIdentity = JSON.parse(indexKey); previousIdentity[1] = CACHE_VERSION - 1;
        const previousIndexKey = JSON.stringify(previousIdentity);
        const previous = await loadState(previousIndexKey);
        cancelled(signal);
        if (previous?.version === CACHE_VERSION - 1 && previous.pages?.length === pdfDocument.numPages &&
            previous.pages.every((page) => Array.isArray(page.blocks)) && Array.isArray(previous.index)) {
          reusableIndex = previous.index; reusableResults = new Map();
          const previousKey = JSON.stringify([previousIndexKey, ...JSON.parse(key).slice(1)]);
          for (const page of createDocumentSentencePages(previous.pages)) {
            const saved = await loadState(`${previousKey}:page:${page.pageNumber}`);
            cancelled(signal);
            for (const unit of page.blocks) if (saved?.translations?.[unit.id]?.status === "done") {
              reusableResults.set(sourceIdentity(unit, page.pageNumber), saved.translations[unit.id]);
            }
          }
        }
      }
      pages = [];
      translationPages = [];
      for (let n = 1; n <= pdfDocument.numPages; n++) {
        cancelled(signal);
        panel.setStatus(`${msg("PDF_Analyzing_Reading_Order", "읽기 순서 분석")}: ${n} / ${pdfDocument.numPages}`);
        const page = await readPage(await pdfDocument.getPage(n), { mode: modes[n] || "auto",
          ...(layout?.pages?.[n - 1] ? { layout: layout.pages[n - 1] } : {}) });
        cancelled(signal);
        pages.push(page);
      }
      pages = filterDocumentBody(pages);
      translationPages = createDocumentSentencePages(pages);
      await restoreUnchangedResults(signal);
      render();
      const firstText = pages.slice(0, 2).flatMap((page) => page.blocks.map((block) => block.text)).join("\n");
      abstract = firstText.match(/\babstract\b[:\s]*([\s\S]{0,900})/i)?.[1] || "";
      const chunks = chunkDocumentPages(pages);
      panel.setStatus(msg("PDF_Building_Document_Index", "논문 전체의 검색용 임베딩을 만들고 있습니다."));
      const vectors = new Map(reusableIndex.filter((chunk) => Array.isArray(chunk.vector) && chunk.vector.length &&
        chunk.vector.every(Number.isFinite) && chunk.vector.some((value) => value !== 0)).map((chunk) => [chunk.text, chunk.vector]));
      const pending = chunks.filter((chunk) => !vectors.has(chunk.text));
      const generated = await indexChunks(pending, embed, { signal,
        onProgress: ({ completed }) => panel.setProgress({ indexed: chunks.length - pending.length + completed, indexTotal: chunks.length }),
      });
      for (const chunk of generated) vectors.set(chunk.text, chunk.vector);
      index = chunks.map((chunk) => ({ ...chunk, vector: vectors.get(chunk.text) }));
      cancelled(signal);
      await saveState(indexKey, { version: CACHE_VERSION, pages, index, abstract });
    }
    cancelled(signal);
    ready = true;
    reusableResults = null; reusableIndex = [];
    panel.setIndexReady(true);
    await showCurrentPage(signal);
    const count = translationPages.reduce((sum, page) => sum + page.blocks.length, 0);
    const layoutStatus = !loadLayout ? "" : layout?.layoutIdentity
      ? msg("PDF_Layout_Docling_CPU", "Docling CPU") + (layout.cache === "computed" ? "" :
        ` · ${msg("PDF_Layout_Cache_Reused", "분석 캐시 사용")}`) + (layout.warning ?
        ` · ${msg("PDF_Layout_Cached_Offline", "분석 서버 연결 없이 저장된 결과를 사용합니다.")}` : "")
      : msg("PDF_Layout_Unavailable", "Docling에 연결하지 못해 기존 읽기 순서 분석을 사용합니다.") + (layout?.error ? ` (${layout.error})` : "");
    panel.setStatus((count ? msg("PDF_Document_Ready", "문서 준비 완료. 페이지 번역 또는 전체 번역을 선택하세요.") :
      pages.some((page) => page.excludedRegionIndices?.length) ? msg("PDF_Region_No_Translation_Targets", "수정한 영역 설정에 따라 번역할 텍스트가 없습니다.") :
      msg("PDF_Scanned_OCR_Required", "선택 가능한 텍스트가 없습니다. 스캔 PDF는 OCR이 필요합니다.")) +
      (layoutStatus ? ` · ${layoutStatus}` : ""));
  }

  async function translatePage(pageNumber, signal, progress) {
    const page = translationPages.find((item) => item.pageNumber === pageNumber);
    const sourcePage = pages.find((item) => item.pageNumber === pageNumber);
    if (!page) throw new Error(msg("PDF_Page_Text_Missing", "페이지 텍스트를 찾을 수 없습니다."));
    await loadPageTranslations(page, signal);
    let errors = 0;
    if (index.length && normalizeContextLimits(settings).total) {
      const pending = page.blocks.filter((block) => resultOf(block, pageNumber)?.status !== "done" &&
        needsTranslation(block) && !queryVectors.has(block.id));
      if (pending.length) {
        panel.setStatus(`${msg("PDF_Translation_Index", "문맥 준비")}: ${pageNumber} / ${pdfDocument.numPages}`);
        const vectors = await embedPageQueries(pending, queryEmbed, { signal,
          onProgress: ({ completed, total }) => panel.setProgress({ indexed: completed, indexTotal: total }) });
        cancelled(signal);
        for (const [id, vector] of vectors) queryVectors.set(id, vector);
      }
    }
    const commit = async (blocks, results) => {
      cancelled(signal);
      blocks.forEach((block, position) => { setResult(block, pageNumber, results[position]); });
      for (const owner of new Set(blocks.map((block) => ownerOf(block, pageNumber)))) {
        cancelled(signal);
        await saveState(pageKey(owner), { translations: translations[owner] });
      }
      cancelled(signal);
      blocks.forEach((block) => progress(block.id));
      render();
    };
    const runOne = async (block) => {
      try { await commit([block], [await translateOne(block, referenceFor(sourcePage, [block]), signal)]); }
      catch (error) {
        cancelled(signal);
        errors += 1;
        setResult(block, pageNumber, { status: "error", error: formatPdfTranslationError(error), errorCode: error.code });
        progress(block.id);
        render();
      }
    };
    const batchable = (block) => block?.unitType === "sentence" && needsTranslation(block) && protectedMathText(block).length <= 900;
    for (let position = 0; position < page.blocks.length;) {
      cancelled(signal);
      const block = page.blocks[position++];
      if (resultOf(block, pageNumber)?.status === "done") { progress(block.id); continue; }
      const group = [block];
      let chars = protectedMathText(block).length;
      while (batchEnabled && batchable(block) && group.length < 10 && position < page.blocks.length) {
        const next = page.blocks[position];
        const length = protectedMathText(next).length;
        if (!batchable(next) || next.kind !== block.kind || resultOf(next, pageNumber)?.status === "done" || chars + length > 900) break;
        group.push(next); position++; chars += length;
      }
      group.forEach((unit) => { setResult(unit, pageNumber, { status: "running", text: "" }); });
      panel.setStatus(`${msg("PDF_Translating_Page", "페이지 번역 중")}: ${pageNumber} / ${pdfDocument.numPages}` +
        (group.length > 1 ? ` · ${group.length} ${msg("PDF_Translation_Sentence", "문장")}` : ""));
      render();
      if (group.length === 1) { await runOne(block); continue; }
      try {
        const entries = group.map(unit => ({ id: unit.id, text: protectedMathText(unit) }));
        const source = entries.map((unit, i) => `[S${i + 1}] ${unit.text}`).join("\n");
        const responses = await translateBatch(entries, target,
          fitReferenceContext(referenceFor(sourcePage, group), source),
          { signal, ...(group.some(unit => unit.inlineMath?.length) ? { preserveMath: true } : {}) });
        cancelled(signal);
        const byId = new Map((Array.isArray(responses) ? responses : []).map((response) => [response?.id, response]));
        if (!Array.isArray(responses) || responses.length !== group.length || byId.size !== group.length ||
            group.some((unit) => typeof byId.get(unit.id)?.targetText !== "string" ||
              !byId.get(unit.id).targetText.trim() || byId.get(unit.id).isBroken || !validMathTranslation(byId.get(unit.id).targetText, unit))) {
          throw Object.assign(new Error("Batch sentence mapping is incomplete"), { code: "BATCH_FORMAT" });
        }
        await commit(group, group.map((unit) => ({ status: "done", text: byId.get(unit.id).targetText })));
      } catch (error) {
        cancelled(signal);
        if (["BATCH_FORMAT", "OUTPUT_LIMIT", "EMPTY_OUTPUT", "INVALID_RESPONSE"].includes(error.code)) {
          batchEnabled = false;
          for (const unit of group) { cancelled(signal); await runOne(unit); }
        } else {
          errors += group.length;
          group.forEach((unit) => {
            setResult(unit, pageNumber, { status: "error", error: formatPdfTranslationError(error), errorCode: error.code });
            progress(unit.id);
          });
          render();
        }
      }
    }
    return errors;
  }

  async function loadPageTranslations(page, signal) {
    if (!page) return;
    const cacheKey = key;
    for (const owner of new Set(page.blocks.map((unit) => ownerOf(unit, page.pageNumber)))) {
      if (translations[owner]) continue;
      const cached = await loadState(pageKey(owner));
      if (signal) cancelled(signal);
      if (destroyed || cacheKey !== key) return;
      translations[owner] ||= cached?.translations || {};
    }
    for (const unit of page.blocks) {
      const result = resultOf(unit, page.pageNumber);
      if (result?.status === "done" && !validMathTranslation(result.text, unit)) delete translations[ownerOf(unit, page.pageNumber)][unit.id];
    }
  }

  async function showCurrentPage(signal) {
    const request = ++pageViewRequest;
    previewRequest++;
    displayedPage = null;
    const n = getCurrentPage();
    const page = translationPages.find((page) => page.pageNumber === n);
    if (!destroyed) render();
    if (ready) {
      const refresh = () => {
        if (!destroyed && request === pageViewRequest && getCurrentPage() === n && displayedPage == null) render();
      };
      await Promise.all([loadPageTranslations(page, signal).then(refresh), loadDisplayParagraphs(page).then(refresh)]);
      if (signal) cancelled(signal);
    }
  }

  function clearSourcePreview() {
    previewRequest++;
    const previous = displayedPage;
    displayedPage = null;
    if (previous != null && previous !== getCurrentPage() && !destroyed) return showCurrentPage().catch(console.warn);
  }

  async function loadDisplayParagraphs(page) {
    if (!page || displayParagraphs.has(page.pageNumber)) return;
    if (displayLoading.has(page.pageNumber)) return displayLoading.get(page.pageNumber);
    const pending = (async () => {
      let content, viewport;
      try {
        const source = await pdfDocument.getPage(page.pageNumber);
        content = await source.getTextContent?.({ includeMarkedContent: true, disableNormalization: true });
        viewport = source.getViewport?.({ scale: 1 });
      } catch (_) {}
      if (!destroyed && translationPages.includes(page)) {
        displayParagraphs.set(page.pageNumber, getDisplayParagraphs(page, content?.items, viewport));
      }
    })();
    displayLoading.set(page.pageNumber, pending);
    try { await pending; }
    finally { if (displayLoading.get(page.pageNumber) === pending) displayLoading.delete(page.pageNumber); }
  }

  async function run(action) {
    if (active || destroyed) return;
    const token = ++generation;
    const aborter = new AbortController();
    active = aborter;
    panel.setError?.("");
    panel.setBusy(true);
    try {
      await action(aborter.signal);
    } catch (error) {
      if (token === generation && error.name !== "AbortError") {
        const execution = error.service === "embedding" ? embeddingBrowser : browserExecution;
        const message = (error.service === "embedding" ? "RAG · " : "") + (execution ? msg("LLM_Execution_Browser", "브라우저에서 실행 (WebGPU)") : msg("LLM_Execution_API", "API (Ollama / 서버)")) +
          " · " + formatPdfTranslationError(error);
        panel.setStatus(message); panel.setError?.(message);
      }
    } finally {
      if (active === aborter) { active = null; panel.setBusy(false); }
    }
  }

  function stop() {
    generation += 1;
    active?.abort();
    if (!replacementWrite) active = null;
    retrying = null;
    panel.setBusy(replacementWrite);
    if (ready && !destroyed) render();
    panel.setStatus(msg("PDF_Translation_Paused", "중지했습니다. 완료된 문장은 저장되어 다음 실행에서 재사용됩니다."));
  }

  function invalidate() {
    pageViewRequest++; previewRequest++;
    ready = false; pages = []; translationPages = []; displayedPage = null; index = [];
    queryVectors.clear(); displayParagraphs.clear(); displayLoading.clear();
    batchEnabled = typeof translateBatch === "function"; translations = {};
    panel.setIndexReady(false);
  }

  return {
    prepare: () => run((signal) => prepare(signal)),
    refreshLayout: () => {
      if (destroyed || replacementWrite) return;
      stop();
      return run(async (signal) => {
        if (ready) {
          for (const page of translationPages) await loadPageTranslations(page, signal);
          reusableResults = new Map(translationPages.flatMap((page) => page.blocks
            .filter((unit) => resultOf(unit, page.pageNumber)?.status === "done")
            .map((unit) => [sourceIdentity(unit, page.pageNumber), resultOf(unit, page.pageNumber)])));
          reusableIndex = index;
        }
        invalidate();
        await prepare(signal);
      });
    },
    getPageUnits: (n) => ready ? translationPages.find((page) => page.pageNumber === n)?.blocks || [] : [],
    findVariableDefinitions: async (variable, anchor) => {
      const currentPages = translationPages, evidence = findVariableEvidence(currentPages, variable, anchor);
      await Promise.all([...new Set(evidence.map((source) => source.pageNumber))]
        .map((n) => loadPageTranslations(currentPages.find((page) => page.pageNumber === n))));
      if (destroyed || translationPages !== currentPages) return [];
      return evidence.map((source) => ({ ...source, translation: resultOf(source.unit, source.pageNumber)?.status === "done"
        ? plainMathText(resultOf(source.unit, source.pageNumber).text, source.unit) : undefined }));
    },
    revealSourceSentence: async (id, n, isCurrent = () => true) => {
      const page = translationPages.find((page) => page.pageNumber === n);
      if (!ready || !page?.blocks.some((unit) => unit.id === id) || !isCurrent()) return false;
      const request = ++previewRequest, viewRequest = pageViewRequest;
      await Promise.all([loadPageTranslations(page), loadDisplayParagraphs(page)]);
      if (destroyed || request !== previewRequest || viewRequest !== pageViewRequest || !translationPages.includes(page) || !isCurrent()) return false;
      displayedPage = n;
      render();
      return panel.highlightSentence?.(id, n) ?? false;
    },
    clearSourcePreview,
    retranslateSentence: (id, mode = "standard", n = getCurrentPage()) => run(async (signal) => {
      if (!["standard", "reduced", "none"].includes(mode)) return;
      await prepare(signal);
      const page = translationPages.find((page) => page.pageNumber === n);
      const block = page?.blocks.find((unit) => unit.id === id);
      if (!block || (block.unitType !== "sentence" && block.kind !== "heading") || !needsTranslation(block)) return;
      await loadPageTranslations(page, signal);
      const request = { id, signal };
      retrying = request;
      render();
      panel.setStatus(msg("PDF_Retranslating_Sentence", "선택한 구간을 다시 번역하고 있습니다."));
      try {
        if (mode === "standard" && index.length && normalizeContextLimits(settings).total && !queryVectors.has(id)) {
          const vectors = await embedPageQueries([block], queryEmbed, { signal });
          cancelled(signal);
          for (const [unitId, vector] of vectors) queryVectors.set(unitId, vector);
        }
        const context = mode === "none" ? "" : mode === "reduced" ? reducedReference(block) :
          referenceFor(pages.find((page) => page.pageNumber === n), [block]);
        const sampling = { temperature: mode === "standard" ? 0.4 : 0.1,
          seed: crypto.getRandomValues(new Uint32Array(1))[0] & 0x7fffffff };
        const result = await translateOne(block, context, signal, sampling);
        const { previousTranslation, ...previous } = resultOf(block, n) || {};
        if (previous.status === "done" && previous.text) result.previousTranslation = previous;
        await replaceSentenceResult(block, n, result, signal);
        panel.setStatus(msg("PDF_Sentence_Retranslated", "선택한 구간의 번역을 교체했습니다."));
      } catch (error) {
        cancelled(signal);
        panel.setStatus(msg("PDF_Sentence_Retranslation_Failed", "재번역에 실패했습니다. 기존 번역을 유지합니다.") + " " + formatPdfTranslationError(error));
      } finally {
        if (retrying === request) { retrying = null; if (!destroyed) render(); }
      }
    }),
    restoreSentence: (id, n = getCurrentPage()) => run(async (signal) => {
      await prepare(signal);
      const page = translationPages.find((page) => page.pageNumber === n);
      const block = page?.blocks.find((unit) => unit.id === id);
      if (!block) return;
      await loadPageTranslations(page, signal);
      const previous = resultOf(block, n)?.previousTranslation;
      if (previous?.status !== "done" || !previous.text) return;
      await replaceSentenceResult(block, n, previous, signal);
      panel.setStatus(msg("PDF_Previous_Translation_Restored", "이전 번역으로 되돌렸습니다."));
    }),
    translatePage: (n = getCurrentPage()) => run(async (signal) => {
      await prepare(signal);
      let completed = 0;
      const total = translationPages.find((page) => page.pageNumber === n)?.blocks.length || 0;
      if (!total) throw new Error(pages.find((page) => page.pageNumber === n)?.excludedRegionIndices?.length
        ? msg("PDF_Region_No_Translation_Targets", "수정한 영역 설정에 따라 번역할 텍스트가 없습니다.")
        : msg("PDF_Page_OCR_Required", "이 페이지에 선택 가능한 텍스트가 없습니다. OCR이 필요할 수 있습니다."));
      const errors = await translatePage(n, signal, () => panel.setProgress({ completed: ++completed, total }));
      panel.setStatus(errors ? `${msg("PDF_Retry_Failed_Blocks", "실패한 문장은 페이지 번역을 다시 눌러 재시도할 수 있습니다.")} (${errors})` : msg("PDF_Page_Translation_Complete", "페이지 번역 완료"));
    }),
    translateAll: () => run(async (signal) => {
      await prepare(signal);
      let completed = 0;
      const units = new Map(translationPages.flatMap((page) => page.blocks.map((unit) => [unit.id, unit])));
      const total = units.size;
      if (!total) throw new Error(pages.some((page) => page.excludedRegionIndices?.length)
        ? msg("PDF_Region_No_Translation_Targets", "수정한 영역 설정에 따라 번역할 텍스트가 없습니다.")
        : msg("PDF_Text_OCR_Required", "선택 가능한 텍스트가 없습니다. OCR이 필요합니다."));
      const current = getCurrentPage();
      const order = [...translationPages.filter((page) => page.pageNumber === current), ...translationPages.filter((page) => page.pageNumber !== current)];
      const counted = new Set();
      for (const page of order) {
        cancelled(signal);
        await translatePage(page.pageNumber, signal, (id) => {
          if (!counted.has(id)) { counted.add(id); panel.setProgress({ completed: ++completed, total }); }
        });
      }
      const errors = [...units.values()].filter((unit) => resultOf(unit, unit.ownerPageNumber)?.status === "error").length;
      panel.setStatus(errors ? `${msg("PDF_Retry_Failed_Blocks", "실패한 문장은 페이지 번역을 다시 눌러 재시도할 수 있습니다.")} (${errors})` : msg("PDF_Document_Translation_Complete", "문서의 텍스트 번역 완료"));
    }),
    setMode: async (mode, n = getCurrentPage()) => {
      if (!["auto", "single", "two"].includes(mode) || destroyed || replacementWrite) return;
      stop();
      modes[n] = mode;
      invalidate();
      await saveState(preferencesKey, { modes });
      return run((signal) => prepare(signal));
    },
    showPage: () => showCurrentPage().catch(console.warn),
    stop,
    destroy: () => { stop(); destroyed = true; panel.destroy(); },
  };
}

export function initializePdfDocumentTranslation() {
  let controller = null;
  let sourceHighlighter = null;
  let sourceHover = null;
  let layoutOverlay = null;
  let regionEditor = null;
  let geometryEditor = null;
  let visualRenderer = null;
  let formulaHover = null;
  let panel = null;
  let linkedHoverEnabled = true;
  let sourceVariableTooltipEnabled = true;
  let layoutOverlayEnabled = false;
  let layoutEditing = false;
  let finishLayoutEditing;
  let sourceRequestId = 0;
  let bootId = 0;
  let connected = false;
  let reloadTimer;
  const connect = async () => {
    const app = window.PDFViewerApplication;
    if (!app || connected) return;
    connected = true;
    await app.initializedPromise;
    const load = async () => {
      const id = ++bootId;
      finishLayoutEditing = null;
      regionEditor?.destroy(); regionEditor = null; layoutEditing = false;
      geometryEditor?.destroy(); geometryEditor = null;
      formulaHover?.destroy(); formulaHover = null;
      visualRenderer?.destroy(); visualRenderer = null;
      sourceHover?.destroy();
      sourceHover = null;
      layoutOverlay?.destroy();
      layoutOverlay = null;
      controller?.destroy();
      sourceHighlighter?.destroy();
      controller = null;
      sourceHighlighter = null;
      const pdfDocument = app.pdfDocument;
      if (!pdfDocument) return;
      const settings = await loadSettings();
      linkedHoverEnabled = settings.pdfLinkedHover !== false && settings.pdfLinkedHover !== "false";
      sourceVariableTooltipEnabled = settings.pdfSourceVariableTooltip !== false && settings.pdfSourceVariableTooltip !== "false";
      layoutOverlayEnabled = settings.pdfShowDoclingRegions === true || settings.pdfShowDoclingRegions === "true";
      await loadUiLanguage(settings.uiLanguage);
      const metadata = await pdfDocument.getMetadata().catch(() => ({}));
      const documentId = await getDocumentCacheId(pdfDocument);
      const [modelIdentity, embeddingModelIdentity] = await Promise.all([
        settings.llmExecution === "browser" ? [] : requestServerApi("modelIdentity", { service: "translation" }, settings).catch(() => []),
        settings.embeddingExecution === "browser" ? [] : requestServerApi("modelIdentity", { service: "embedding" }, settings).catch(() => []),
      ]);
      if (id !== bootId) return;
      sourceHighlighter = createPdfSourceHighlighter({ app, pdfDocument, isCurrent: () => id === bootId });
      const editStore = createRegionEditStore({ documentId });
      let rawLayout, pendingEdits = false;
      const changeEditing = (enabled) => {
        if (id !== bootId) return;
        layoutEditing = enabled;
        panel?.setLayoutEditing(enabled);
        layoutOverlay?.setEditing(enabled);
        sourceHover?.clear(); sourceHighlighter?.clear();
        visualRenderer?.hideTooltip();
        formulaHover?.clear();
        if (enabled) {
          layoutOverlayEnabled = true; panel?.setLayoutOverlayEnabled(true); layoutOverlay?.setEnabled(true);
          void browser.storage.local.set({ pdfShowDoclingRegions: "true" }).catch(console.warn);
          panel?.setStatus(msg("PDF_Region_Edit_Help", "영역을 클릭해 수정하고 저장하세요. 끝나면 수정 적용을 누르세요."));
        } else {
          regionEditor?.close();
          geometryEditor?.close();
          if (pendingEdits) { pendingEdits = false; void controller?.refreshLayout(); }
        }
      };
      finishLayoutEditing = () => changeEditing(false);
      layoutOverlay = createPdfLayoutOverlay({ app, enabled: layoutOverlayEnabled, isCurrent: () => id === bootId,
        onEditRegion: (page, region) => { if (layoutEditing && !geometryEditor?.isOpen()) regionEditor?.open(page, region); } });
      const saveRegion = async (page, region, edit) => {
        await editStore.save(page, region, edit);
        if (id !== bootId) return;
        pendingEdits = true;
        const updated = await editStore.apply(rawLayout);
        if (id !== bootId) return;
        layoutOverlay?.setLayout(updated.pages);
        panel?.setStatus(msg("PDF_Region_Saved", "영역 수정을 저장했습니다. 수정 적용을 누르면 번역 대상에 반영됩니다."));
        if (!layoutEditing) { pendingEdits = false; void controller?.refreshLayout(); }
      };
      geometryEditor = createPdfRegionGeometryEditor({ app, onSave: saveRegion, isCurrent: () => id === bootId });
      regionEditor = createPdfRegionEditor({ onSave: saveRegion,
        onEditGeometry: (page, region) => geometryEditor.open(page, region) });
      visualRenderer = createPdfVisualRenderer({ pdfDocument, isCurrent: () => id === bootId,
        findDefinitions: (variable, anchor) => controller?.findVariableDefinitions(variable, anchor) || [],
        onJumpToEvidence: (evidence) => { void sourceHighlighter?.show(evidence.unit, evidence.pageNumber); } });
      panel = createPdfTranslationPanel({
        renderVisual: (container, block) => visualRenderer.render(container, block),
        renderInlineMath: (container, block, text) => visualRenderer.renderInline(container, block, text),
        releaseVisual: (container) => visualRenderer?.release(container),
        hideVisualTooltip: () => visualRenderer?.hideTooltip(),
        sourceVariableTooltip: sourceVariableTooltipEnabled,
        onSourceVariableTooltipChange: (enabled) => {
          sourceVariableTooltipEnabled = enabled;
          if (!enabled) formulaHover?.clear();
          void browser.storage.local.set({ pdfSourceVariableTooltip: String(enabled) }).catch(console.warn);
        },
        linkedHover: linkedHoverEnabled,
        layoutOverlay: layoutOverlayEnabled,
        onLayoutEditingChange: changeEditing,
        onLayoutOverlayChange: (enabled) => {
          layoutOverlayEnabled = enabled;
          if (!enabled && layoutEditing) changeEditing(false);
          layoutOverlay?.setEnabled(enabled);
          void browser.storage.local.set({ pdfShowDoclingRegions: String(enabled) }).catch(console.warn);
        },
        onLinkedHoverChange: (enabled) => {
          linkedHoverEnabled = enabled;
          sourceHover?.clear(); sourceHighlighter?.clearHover();
          void browser.storage.local.set({ pdfLinkedHover: String(enabled) }).catch(console.warn);
        },
        onRetranslateSentence: (block, n, mode) => controller?.retranslateSentence(block.id, mode, n),
        onRestoreSentence: (block, n) => controller?.restoreSentence(block.id, n),
        onTranslatePage: (n) => controller?.translatePage(n),
        onTranslateAll: () => controller?.translateAll(),
        onStop: () => controller?.stop(),
        onModeChange: (mode, n) => {
          sourceHover?.clear();
          formulaHover?.clear();
          sourceRequestId += 1;
          sourceHighlighter?.clear();
          return controller?.setMode(mode, n);
        },
        onHoverSentence: (block, n) => {
          if (id !== bootId || !linkedHoverEnabled || layoutEditing) return;
          sourceRequestId += 1;
          void sourceHighlighter?.show(block, n, { navigate: false });
        },
        onLeaveSentence: () => { sourceHighlighter?.clearHover(); sourceHover?.clear(); },
        onJumpToBlock: async (block, n) => {
          const requestId = ++sourceRequestId;
          const highlighted = await sourceHighlighter?.show(block, n);
          if (id === bootId && requestId === sourceRequestId && app.page === n && !highlighted) {
            panel.setStatus(msg("PDF_Source_Location_Unavailable", "이 문장의 정확한 원문 위치를 찾지 못했습니다."));
          }
        },
      });
      const layoutClient = createDoclingLayoutClient({ pdfDocument, documentId, settings,
        autoStart: settings.pdfDoclingAutoStart !== false && settings.pdfDoclingAutoStart !== "false" });
      controller = createPdfTranslationController({ pdfDocument, panel, settings,
        documentId, modelIdentity, embeddingModelIdentity,
        loadLayout: async (options) => {
          rawLayout = await layoutClient(options);
          const result = await editStore.apply(rawLayout);
          if (id === bootId) {
            layoutOverlay?.setLayout(result.pages);
            panel?.setLayoutEditable(!!result.pages?.some((page) => page.regions.length));
          }
          return result;
        },
        title: metadata.info?.Title || document.title, getCurrentPage: () => app.page || 1,
      });
      sourceHover = createPdfSourceHover({ app, pdfDocument, sourceHighlighter,
        getUnits: (n) => controller?.getPageUnits(n) || [],
        isEnabled: () => !layoutEditing && linkedHoverEnabled && !!panel?.isOpen(),
        isCurrent: () => id === bootId,
        onHover: (unit, n, current) => controller?.revealSourceSentence(unit.id, n, current),
        onLeave: () => { controller?.clearSourcePreview(); panel?.clearSentenceHighlight(); },
      });
      formulaHover = createPdfFormulaHover({ app, pdfDocument, visualRenderer,
        getUnits: (n) => controller?.getPageUnits(n) || [],
        isEnabled: () => !layoutEditing && sourceVariableTooltipEnabled,
        isCurrent: () => id === bootId,
      });
      void controller.prepare();
    };
    app.eventBus.on("documentloaded", () => { void load().catch(console.warn); });
    app.eventBus.on("pagechanging", () => controller?.showPage());
    browser.storage.onChanged.addListener((changes, namespace) => {
      if (namespace === "local" && changes.pdfSourceVariableTooltip) {
        const value = changes.pdfSourceVariableTooltip.newValue;
        sourceVariableTooltipEnabled = value !== false && value !== "false";
        panel?.setSourceVariableTooltipEnabled(sourceVariableTooltipEnabled);
        if (!sourceVariableTooltipEnabled) formulaHover?.clear();
      }
      if (namespace === "local" && changes.pdfShowDoclingRegions) {
        const value = changes.pdfShowDoclingRegions.newValue;
        layoutOverlayEnabled = value === true || value === "true";
        panel?.setLayoutOverlayEnabled(layoutOverlayEnabled);
        if (!layoutOverlayEnabled && layoutEditing) finishLayoutEditing?.();
        layoutOverlay?.setEnabled(layoutOverlayEnabled);
      }
      if (namespace === "local" && changes.pdfLinkedHover) {
        const value = changes.pdfLinkedHover.newValue;
        linkedHoverEnabled = value !== false && value !== "false";
        panel?.setLinkedHoverEnabled(linkedHoverEnabled);
        if (!linkedHoverEnabled) { sourceHover?.clear(); sourceHighlighter?.clearHover(); }
      }
      if (namespace === "local" && Object.keys(changes).some((key) => key.startsWith("llm") || key.startsWith("embedding") || key.startsWith("docling") || key === "pdfDoclingAutoStart" || key === "translateTarget" || key === "uiLanguage")) {
        controller?.stop();
        clearTimeout(reloadTimer);
        reloadTimer = setTimeout(() => { void load().catch(console.warn); }, 400);
      }
    });
    window.addEventListener("pagehide", () => { clearTimeout(reloadTimer); bootId += 1; regionEditor?.destroy(); geometryEditor?.destroy(); formulaHover?.destroy(); visualRenderer?.destroy(); layoutOverlay?.destroy(); sourceHover?.destroy(); controller?.destroy(); sourceHighlighter?.destroy(); });
    if (app.pdfDocument) await load();
  };
  document.addEventListener("webviewerloaded", () => { void connect().catch(console.warn); }, { once: true });
  if (window.PDFViewerApplication) void connect().catch(console.warn);
}
