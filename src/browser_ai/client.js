import browser from 'webextension-polyfill';
import { requestInBackground } from './broker_core.js';

export function requestBrowserAi(payload, { signal, onProgress } = {}) {
  if (typeof ServiceWorkerGlobalScope !== 'undefined' && self instanceof ServiceWorkerGlobalScope) {
    return requestInBackground(payload, { signal, onProgress });
  }
  if (signal?.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'));
  return new Promise((resolve, reject) => {
    let port, keepalive, done = false;
    const finish = (error, result) => {
      if (done) return; done = true;
      clearInterval(keepalive); signal?.removeEventListener('abort', abort);
      try { port?.disconnect(); } catch (_) {}
      error ? reject(error) : resolve(result);
    };
    const abort = () => {
      try { port?.postMessage({ kind: 'cancel' }); } catch (_) {}
      finish(new DOMException('Stopped', 'AbortError'));
    };
    try {
      port = browser.runtime.connect({ name: 'paper-browser-ai-client' });
      port.onMessage.addListener(message => {
        if (message.kind === 'progress') onProgress?.(message.event);
        else if (message.kind === 'result') finish(null, message.result);
        else if (message.kind === 'error') finish(Object.assign(new Error(message.error?.message || 'Browser AI failed.'),
          { name: message.error?.name || 'BrowserAiError', code: typeof message.error?.code === 'string' ? message.error.code : 'BROWSER_RUNTIME' }));
      });
      port.onDisconnect.addListener(() => finish(Object.assign(new Error('Browser AI connection closed. Retry the request.'), { code: 'BROWSER_DISCONNECTED' })));
      signal?.addEventListener('abort', abort, { once: true });
      keepalive = setInterval(() => { try { port.postMessage({ kind: 'ping' }); } catch (_) {} }, 20000);
      port.postMessage({ kind: 'request', payload });
      if (signal?.aborted) abort();
    } catch (error) { finish(error); }
  });
}
