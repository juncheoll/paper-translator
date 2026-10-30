import { getMessage } from "../i18n.js";

const msg = (key, fallback) => getMessage(key) || fallback;
const cancelled = signal => { if (signal?.aborted) throw new DOMException("Stopped", "AbortError"); };
const fail = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });

export function requireLlmEndpoint(endpoint) {
  try {
    const url = new URL(endpoint);
    if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash) return url;
  } catch (_) {}
  throw fail("CONFIGURATION", msg("PDF_Local_Endpoint_Required", "HTTP 또는 HTTPS API 기본 주소를 설정해 주세요. 인증키는 별도 칸에 입력하세요."));
}

export function ollamaApiUrl(endpoint, action) {
  if (!["tags", "embed"].includes(action)) throw fail("CONFIGURATION", "Unknown Ollama API action.");
  const url = requireLlmEndpoint(endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, "").replace(/\/v1$/, "")}/api/${action}`;
  return url.href;
}

export function serviceConfiguration(settings, service = "translation") {
  if (!["translation", "embedding"].includes(service)) throw fail("PDF_API_REQUEST", "Unknown API service.");
  return service === "embedding"
    ? { execution: settings.embeddingExecution, endpoint: settings.embeddingApiEndpoint,
      model: settings.embeddingModel, key: settings.embeddingApiKey, type: settings.embeddingApiType || "ollama" }
    : { execution: settings.llmExecution, endpoint: settings.llmApiEndpoint,
      model: settings.llmModel, key: settings.llmApiKey, type: "openai" };
}

function modelsUrl(config) {
  if (config.type === "ollama") return ollamaApiUrl(config.endpoint, "tags");
  const url = requireLlmEndpoint(config.endpoint);
  url.pathname = `${url.pathname.replace(/\/+$/, "")}/models`;
  return url.href;
}

function namesMatch(actual, expected) {
  return actual === expected || actual === `${expected}:latest` || `${actual}:latest` === expected;
}

async function getModels(config, { signal, timeout = 5000 } = {}) {
  const response = await fetch(modelsUrl(config), { credentials: "omit", redirect: "error",
    signal: AbortSignal.any([signal, AbortSignal.timeout(timeout)].filter(Boolean)),
    headers: config.key ? { Authorization: `Bearer ${config.key}` } : {} });
  if (!response.ok) throw fail("HTTP_ERROR", `API 서버 연결 실패 (HTTP ${response.status}).`, { status: response.status });
  const data = await response.json();
  const models = config.type === "ollama" ? data.models : data.data;
  if (!Array.isArray(models)) throw fail("INVALID_RESPONSE", "서버에서 올바른 모델 목록을 반환하지 않았습니다.");
  return models;
}

// Model digests are optional metadata; endpoint and configured model also isolate every cache.
export async function fetchOllamaModelIdentity(settings, { signal, service = "translation" } = {}) {
  try {
    const config = serviceConfiguration(settings, service);
    // Translation URLs normally expose both OpenAI /models and native Ollama /api/tags.
    const models = await getModels({ ...config, type: "ollama" }, { signal });
    return models.filter(model => namesMatch(model.name, config.model) && typeof model.digest === "string")
      .map(model => [model.name, model.digest]);
  } catch (_) { cancelled(signal); return []; }
}

export async function checkApiConnection(settings, { signal, service = "translation" } = {}) {
  cancelled(signal);
  const config = serviceConfiguration(settings, service);
  try {
    const models = (await getModels(config, { signal, timeout: 15000 }))
      .map(model => model.id || model.name).filter(name => typeof name === "string");
    cancelled(signal);
    return { ok: true, modelAvailable: models.some(name => namesMatch(name, config.model)), models };
  } catch (error) {
    cancelled(signal);
    if (error.name === "TimeoutError") throw fail("TIMEOUT", "API 서버 연결 확인 시간이 초과되었습니다.");
    if (error instanceof TypeError) throw fail("CONNECTION_ERROR", "API 서버에 연결하지 못했습니다. 주소와 확장프로그램 연결 권한을 확인하세요.");
    throw error;
  }
}

function checkedVectors(vectors, count) {
  if (!Array.isArray(vectors) || vectors.length !== count || !vectors.length ||
      !Array.isArray(vectors[0]) || !vectors[0].length || vectors[0].length > 65536 ||
      vectors.some(vector => !Array.isArray(vector) || vector.length !== vectors[0].length || !vector.every(Number.isFinite) ||
        !vector.some(value => value !== 0))) throw fail("INVALID_RESPONSE", "임베딩 서버가 잘못된 벡터를 반환했습니다.");
  return vectors;
}

// The name is retained for the PDF core; the endpoint is independent from translation.
export async function embedWithOllama(input, settings, { signal } = {}) {
  cancelled(signal);
  const config = serviceConfiguration(settings, "embedding");
  if (!config.model || !["ollama", "openai"].includes(config.type)) throw fail("CONFIGURATION", "임베딩 모델과 API 형식을 설정해 주세요.");
  const endpoint = config.type === "ollama" ? ollamaApiUrl(config.endpoint, "embed")
    : `${requireLlmEndpoint(config.endpoint).href.replace(/\/+$/, "")}/embeddings`;
  try {
    const response = await fetch(endpoint, {
      method: "POST", credentials: "omit", redirect: "error",
      signal: AbortSignal.any([signal, AbortSignal.timeout(60000)].filter(Boolean)),
      headers: { "Content-Type": "application/json", ...(config.key ? { Authorization: `Bearer ${config.key}` } : {}) },
      body: JSON.stringify({ model: config.model, input, ...(config.type === "ollama" ? { truncate: false } : { encoding_format: "float" }) }),
    });
    if (!response.ok) throw fail("HTTP_ERROR", `임베딩 요청 실패 (HTTP ${response.status}) · ${endpoint}`, { status: response.status });
    const data = await response.json();
    cancelled(signal);
    if (config.type === "ollama") return checkedVectors(data.embeddings, input.length);
    if (!Array.isArray(data.data) || data.data.length !== input.length ||
        data.data.some(item => !Number.isInteger(item.index) || item.index < 0 || item.index >= input.length) ||
        new Set(data.data.map(item => item.index)).size !== input.length) throw fail("INVALID_RESPONSE", "임베딩 응답의 항목 번호가 올바르지 않습니다.");
    return checkedVectors([...data.data].sort((a, b) => a.index - b.index).map(item => item.embedding), input.length);
  } catch (error) {
    cancelled(signal);
    if (error.name === "TimeoutError") throw fail("PDF_EMBEDDING_TIMEOUT", `PDF 임베딩 서버 응답 시간이 초과되었습니다. · ${endpoint}`);
    if (error instanceof TypeError) throw fail("PDF_EMBEDDING_CONNECTION", `PDF 임베딩 서버 요청에 실패했습니다. 주소와 브라우저 연결 권한을 확인하세요. · ${endpoint}`);
    throw error;
  }
}
