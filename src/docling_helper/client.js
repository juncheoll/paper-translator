import browser from 'webextension-polyfill';

export const DOCLING_HELPER_PORT = 'paper-docling-helper';
const deadlines = { status: 10000, start: 180000, prepare: 600000, stop: 30000, unload: 30000 };

export function requestDoclingHelper(payload, { signal, onProgress } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'));
  return new Promise((resolve, reject) => {
    let port, keepalive, deadline, done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true;
      clearInterval(keepalive); clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      try { port?.disconnect(); } catch (_) {}
      error ? reject(error) : resolve(result);
    };
    const cancel = () => { try { port?.postMessage({ kind: 'cancel' }); } catch (_) {} };
    const abort = () => { cancel(); finish(new DOMException('Stopped', 'AbortError')); };
    try {
      port = browser.runtime.connect({ name: DOCLING_HELPER_PORT });
      port.onMessage.addListener(message => {
        if (message?.kind === 'progress') onProgress?.(message.event);
        else if (message?.kind === 'result') finish(null, message.result);
        else if (message?.kind === 'error') finish(Object.assign(new Error(message.error?.message || 'Docling helper failed.'), {
          name: typeof message.error?.name === 'string' ? message.error.name : 'Error',
          code: typeof message.error?.code === 'string' ? message.error.code : 'DOCLING_HELPER_FAILED',
        }));
      });
      port.onDisconnect.addListener(() => finish(Object.assign(new Error('Docling helper connection closed.'), { code: 'DOCLING_HELPER_DISCONNECTED' })));
      signal?.addEventListener('abort', abort, { once: true });
      keepalive = setInterval(() => { try { port.postMessage({ kind: 'ping' }); } catch (_) {} }, 20000);
      deadline = setTimeout(() => {
        cancel(); finish(Object.assign(new Error('Docling helper request timed out.'), { code: 'DOCLING_HELPER_TIMEOUT' }));
      }, deadlines[payload?.operation] || 10000);
      port.postMessage({ kind: 'request', payload });
      if (signal?.aborted) abort();
    } catch (_) { finish(Object.assign(new Error('Docling helper connection could not start.'), { code: 'DOCLING_HELPER_DISCONNECTED' })); }
  });
}
