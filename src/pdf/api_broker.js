import browser from "webextension-polyfill";
import { defaultData } from "../settings.js";
import localLlm from "../services/translation.js";
import { requireLlmEndpoint, embedWithOllama, fetchOllamaModelIdentity, checkApiConnection, serviceConfiguration } from "./ollama_api.js";
import { PDF_API_PORT } from "./api_client.js";

const fail = (code, message) => Object.assign(new Error(message), { code });
const stopped = signal => { if (signal.aborted) throw new DOMException("Stopped", "AbortError"); };
const text = (value, limit, empty = false) => typeof value === "string" && value.length <= limit && (empty || !!value.trim());
const keysOnly = (value, allowed) => value && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).every(key => allowed.includes(key));

function trustedPage(sender) {
  if (sender?.id !== browser.runtime.id) return null;
  try {
    const actual = new URL(sender.url), expected = new URL(browser.runtime.getURL("settings.html"));
    if (actual.protocol !== expected.protocol || actual.host !== expected.host) return null;
    if (actual.pathname === "/pdfjs/web/viewer.html") return "viewer";
    if (actual.pathname === "/settings.html") return "settings";
  } catch (_) {}
  return null;
}

function validate(payload) {
  const invalid = () => { throw fail("PDF_API_REQUEST", "Invalid PDF API request."); };
  const common = ["operation", "configuration", "service"];
  const operationKeys = {
    embed: ["input"], modelIdentity: [], check: [],
    translate: ["text", "target", "context", "options"],
    translateBatch: ["entries", "target", "context", "options"],
  };
  if (!payload || !Object.hasOwn(operationKeys, payload.operation) ||
      !keysOnly(payload, [...common, ...operationKeys[payload.operation]]) ||
      !keysOnly(payload.configuration, ["endpoint", "model", "type"]) ||
      !text(payload.configuration.endpoint, 8192) || !text(payload.configuration.model, 1000) ||
      (payload.configuration.type !== undefined && !["ollama", "openai"].includes(payload.configuration.type)) ||
      (payload.service !== undefined && (!["modelIdentity", "check"].includes(payload.operation) ||
        !["translation", "embedding"].includes(payload.service)))) invalid();
  if (payload.operation === "embed") {
    if (!Array.isArray(payload.input) || !payload.input.length || payload.input.length > 32 ||
        payload.input.some(value => !text(value, 20000))) invalid();
  } else if (["translate", "translateBatch"].includes(payload.operation)) {
    if (!text(payload.target, 100) || (payload.context !== undefined && !text(payload.context, 12000, true))) invalid();
    const options = payload.options || {};
    if (!keysOnly(options, payload.operation === "translate" ? ["temperature", "seed", "preserveMath"] : ["preserveMath"]) ||
        (options.preserveMath !== undefined && typeof options.preserveMath !== "boolean") ||
        (options.temperature !== undefined && (!Number.isFinite(options.temperature) || options.temperature < 0 || options.temperature > 2)) ||
        (options.seed !== undefined && (!Number.isInteger(options.seed) || options.seed < 0 || options.seed > 0x7fffffff))) invalid();
    if (payload.operation === "translate") {
      if (!text(payload.text, 20000)) invalid();
    } else if (!Array.isArray(payload.entries) || !payload.entries.length || payload.entries.length > 10 ||
        payload.entries.some(entry => !keysOnly(entry, ["id", "text"]) || !text(entry.id, 1000) || !text(entry.text, 900)) ||
        new Set(payload.entries.map(entry => entry.id)).size !== payload.entries.length ||
        payload.entries.reduce((sum, entry) => sum + entry.text.length, 0) > 900) invalid();
  }
}

async function execute(payload, signal) {
  validate(payload);
  const settings = { ...defaultData, ...await browser.storage.local.get([
    "llmExecution", "llmApiEndpoint", "llmModel", "llmApiKey",
    "embeddingExecution", "embeddingApiEndpoint", "embeddingApiKey", "embeddingModel", "embeddingApiType",
  ]) };
  stopped(signal);
  const service = payload.operation === "embed" ? "embedding" : payload.service || "translation";
  const config = serviceConfiguration(settings, service);
  if (config.execution === "browser" || config.endpoint !== payload.configuration.endpoint ||
      config.model !== payload.configuration.model ||
      (payload.configuration.type !== undefined && config.type !== payload.configuration.type)) {
    throw fail("PDF_API_CONFIG_CHANGED", "The API settings changed. Retry with the current settings.");
  }
  const endpoint = requireLlmEndpoint(config.endpoint);
  if (browser.permissions?.contains && !await browser.permissions.contains({ origins: [`${endpoint.protocol}//${endpoint.hostname}/*`] })) {
    throw fail("PDF_API_PERMISSION", "Allow this extension to access the configured API server in Chrome extension settings.");
  }
  stopped(signal);
  switch (payload.operation) {
    case "embed": return embedWithOllama(payload.input, settings, { signal });
    case "modelIdentity": return fetchOllamaModelIdentity(settings, { signal, service });
    case "check": return checkApiConnection(settings, { signal, service });
    case "translate": return localLlm.translateStrict(payload.text, "auto", payload.target, settings, payload.context || "", {
      ...payload.options, signal, sentenceOnly: true,
    });
    case "translateBatch": return localLlm.translateBatchStrict(payload.entries, "auto", payload.target, settings, payload.context || "", {
      ...payload.options, signal,
    });
  }
}

let registered = false;
export function registerPdfApiBroker() {
  if (registered) return;
  registered = true;
  browser.runtime.onConnect.addListener(port => {
    if (port.name !== PDF_API_PORT) return;
    const page = trustedPage(port.sender);
    if (!page) { port.disconnect(); return; }
    const controller = new AbortController();
    let requested = false, disconnected = false;
    const send = message => { if (!disconnected) { try { port.postMessage(message); } catch (_) {} } };
    port.onMessage.addListener(message => {
      if (message?.kind === "cancel") { controller.abort(); return; }
      if (message?.kind !== "request" || requested) return;
      requested = true;
      if (page === "settings" && !["check", "modelIdentity"].includes(message.payload?.operation)) {
        send({ kind: "error", error: { code: "PDF_API_REQUEST", message: "Settings can only check configured services." } });
        return;
      }
      void execute(message.payload, controller.signal).then(result => {
        stopped(controller.signal);
        send({ kind: "result", result });
      }).catch(error => send({ kind: "error", error: {
        name: error.name, message: error.message,
        code: typeof error.code === "string" ? error.code : "PDF_API_ERROR",
        ...(Number.isInteger(error.status) ? { status: error.status } : {}),
      } }));
    });
    port.onDisconnect.addListener(() => { disconnected = true; controller.abort(); });
  });
}
