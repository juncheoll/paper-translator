import browser from "webextension-polyfill";

export const PDF_API_PORT = "paper-pdf-api";

// A dedicated port carries cancellation and keeps the service worker active during inference.
export function requestPdfApi(payload, { signal } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException("Stopped", "AbortError"));
  return new Promise((resolve, reject) => {
    let port, keepalive, deadline, done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearInterval(keepalive);
      clearTimeout(deadline);
      signal?.removeEventListener("abort", abort);
      try { port?.disconnect(); } catch (_) {}
      error ? reject(error) : resolve(result);
    };
    const cancel = () => { try { port?.postMessage({ kind: "cancel" }); } catch (_) {} };
    const abort = () => {
      cancel();
      finish(new DOMException("Stopped", "AbortError"));
    };
    try {
      port = browser.runtime.connect({ name: PDF_API_PORT });
      port.onMessage.addListener(message => {
        if (message?.kind === "result") finish(null, message.result);
        else if (message?.kind === "error") {
          const data = message.error || {};
          finish(Object.assign(new Error(data.message || "PDF API request failed."), {
            name: typeof data.name === "string" ? data.name : "Error",
            code: typeof data.code === "string" ? data.code : "PDF_API_ERROR",
            ...(Number.isInteger(data.status) ? { status: data.status } : {}),
          }));
        }
      });
      port.onDisconnect.addListener(() => finish(Object.assign(
        new Error("PDF API connection closed. Reload the extension and PDF, then retry."),
        { code: "PDF_API_DISCONNECTED" })));
      signal?.addEventListener("abort", abort, { once: true });
      keepalive = setInterval(() => { try { port.postMessage({ kind: "ping" }); } catch (_) {} }, 20000);
      deadline = setTimeout(() => {
        cancel();
        finish(Object.assign(new Error("PDF API request timed out."), { code: "PDF_API_TIMEOUT" }));
      }, 75000);
      port.postMessage({ kind: "request", payload });
      if (signal?.aborted) abort();
    } catch (_) {
      finish(Object.assign(new Error("PDF API connection could not start. Reload the extension and PDF, then retry."),
        { code: "PDF_API_DISCONNECTED" }));
    }
  });
}
