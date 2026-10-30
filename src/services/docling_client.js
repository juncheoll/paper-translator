import browser from 'webextension-polyfill';
import { doclingConfiguration } from './docling_config.js';
export { stageDoclingUpload, discardDoclingUpload } from './docling_uploads.js';

export const DOCLING_API_PORT = 'paper-docling-api';
export async function requestDoclingApi(payload, { signal } = {}) {
  if (signal?.aborted) throw new DOMException('Stopped', 'AbortError');
  if (!payload.configuration) payload = { ...payload, configuration: doclingConfiguration(await browser.storage.local.get([
    'doclingExecution', 'doclingApiEndpoint',
  ])) };
  return new Promise((resolve, reject) => {
    let port, keepalive, deadline, done = false;
    const finish = (error, result) => {
      if (done) return;
      done = true; clearInterval(keepalive); clearTimeout(deadline);
      signal?.removeEventListener('abort', abort);
      try { port?.disconnect(); } catch (_) {}
      error ? reject(error) : resolve(result);
    };
    const cancel = () => { try { port?.postMessage({ kind: 'cancel' }); } catch (_) {} };
    const abort = () => { cancel(); finish(new DOMException('Stopped', 'AbortError')); };
    try {
      port = browser.runtime.connect({ name: DOCLING_API_PORT });
      port.onMessage.addListener(message => {
        if (message?.kind === 'result') finish(null, message.result);
        else if (message?.kind === 'error') finish(Object.assign(new Error(message.error?.message || 'Docling 요청에 실패했습니다.'), {
          name: message.error?.name || 'Error', code: message.error?.code || 'DOCLING_API_ERROR', status: message.error?.status,
        }));
      });
      port.onDisconnect.addListener(() => finish(Object.assign(new Error('Docling 백그라운드 연결이 종료되었습니다.'), { code: 'DOCLING_API_DISCONNECTED' })));
      signal?.addEventListener('abort', abort, { once: true });
      keepalive = setInterval(() => { try { port.postMessage({ kind: 'ping' }); } catch (_) {} }, 20000);
      deadline = setTimeout(() => { cancel(); finish(Object.assign(new Error('Docling 응답 시간이 초과되었습니다.'), { code: 'DOCLING_API_TIMEOUT' })); },
        payload.operation === 'analyze' ? 265000 : 12000);
      port.postMessage({ kind: 'request', payload });
      if (signal?.aborted) abort();
    } catch (error) { finish(error); }
  });
}
