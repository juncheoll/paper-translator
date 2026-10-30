import browser from 'webextension-polyfill';
import { DOCLING_API_PORT } from './docling_client.js';
import { doclingConfiguration } from './docling_config.js';
import { takeDoclingUpload, purgeDoclingUploads, discardDoclingUpload } from './docling_uploads.js';

const failure = (code, message, details = {}) => Object.assign(new Error(message), { code, ...details });
const stopped = signal => { if (signal.aborted) throw new DOMException('Stopped', 'AbortError'); };
const only = (value, allowed) => value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(key => allowed.includes(key));
export function trustedDoclingSender(sender) {
  if (sender?.id !== browser.runtime.id) return false;
  try {
    const actual = new URL(sender.url), own = new URL(browser.runtime.getURL('settings.html'));
    return actual.protocol === own.protocol && actual.host === own.host &&
      [own.pathname, new URL(browser.runtime.getURL('pdfjs/web/viewer.html')).pathname].includes(actual.pathname);
  } catch (_) { return false; }
}

export async function executeDoclingRequest(payload, signal, { readSettings = () => browser.storage.local.get([
  'doclingExecution', 'doclingApiEndpoint', 'doclingApiKey',
]), request = globalThis.fetch, takeUpload = takeDoclingUpload } = {}) {
  if (!only(payload, ['operation', 'configuration', 'documentId', 'uploadId']) ||
      !['info', 'cache', 'analyze'].includes(payload.operation) ||
      !only(payload.configuration, ['execution', 'endpoint']) ||
      !['local', 'server'].includes(payload.configuration.execution) || typeof payload.configuration.endpoint !== 'string' ||
      (payload.operation !== 'info' && !/^[a-f0-9]{64}$/.test(payload.documentId)) ||
      (payload.operation === 'analyze' && !/^[a-f0-9-]{36}$/.test(payload.uploadId)) ||
      (payload.operation !== 'analyze' && payload.uploadId !== undefined) ||
      (payload.operation === 'info' && payload.documentId !== undefined)) {
    throw failure('DOCLING_API_REQUEST', 'Invalid Docling API request.');
  }
  const settings = await readSettings(), configuration = doclingConfiguration(settings);
  stopped(signal);
  if (configuration.execution !== payload.configuration.execution || configuration.endpoint !== payload.configuration.endpoint) {
    throw failure('DOCLING_CONFIG_CHANGED', 'Docling 설정이 변경되었습니다. 다시 시도하세요.');
  }
  const headers = {};
  if (configuration.execution === 'server' && settings.doclingApiKey) headers.Authorization = `Bearer ${settings.doclingApiKey}`;
  const controller = new AbortController(), abort = () => controller.abort();
  signal.addEventListener('abort', abort, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, payload.operation === 'analyze' ? 255000 : 10000);
  try {
    let body;
    if (payload.operation === 'analyze') {
      body = await takeUpload(payload.uploadId);
      stopped(signal);
      if (!new TextDecoder().decode(await body.slice(0, 1024).arrayBuffer()).includes('%PDF-')) throw failure('DOCLING_API_REQUEST', 'Invalid PDF upload.');
      headers['Content-Type'] = 'application/pdf';
    }
    const path = payload.operation === 'info' ? '/v1/info' : `/v1/layout/${payload.documentId}`;
    const response = await request(configuration.endpoint + path, { method: body ? 'POST' : 'GET', body, headers,
      signal: controller.signal, credentials: 'omit', redirect: 'error', cache: 'no-store' });
    if (payload.operation === 'cache' && response.status === 404) return null;
    if (!response.ok) throw failure('DOCLING_HTTP_ERROR', `Docling HTTP ${response.status}. 서버 주소·인증·처리 상태를 확인하세요.`, { status: response.status });
    const result = await response.json();
    stopped(signal);
    return result;
  } catch (error) {
    stopped(signal);
    if (timedOut) throw failure('DOCLING_API_TIMEOUT', 'Docling 응답 시간이 초과되었습니다. 서버 상태를 확인하세요.');
    if (error.code) throw error;
    throw failure('DOCLING_API_CONNECTION', `Docling 연결에 실패했습니다: ${configuration.endpoint}. 주소와 확장프로그램의 사이트 접근 권한을 확인하세요.`);
  } finally { clearTimeout(timer); signal.removeEventListener('abort', abort); }
}

let registered = false;
export function registerDoclingApiBroker() {
  if (registered) return;
  registered = true;
  void purgeDoclingUploads().catch(() => {});
  browser.runtime.onConnect.addListener(port => {
    if (port.name !== DOCLING_API_PORT) return;
    if (!trustedDoclingSender(port.sender)) { port.disconnect(); return; }
    let requested = false, disconnected = false, uploadId;
    const controller = new AbortController();
    const send = message => { if (!disconnected) try { port.postMessage(message); } catch (_) {} };
    port.onMessage.addListener(message => {
      if (message?.kind === 'cancel') { controller.abort(); if (uploadId) void discardDoclingUpload(uploadId).catch(() => {}); return; }
      if (message?.kind !== 'request' || requested) return;
      requested = true;
      if (typeof message.payload?.uploadId === 'string' && /^[a-f0-9-]{36}$/.test(message.payload.uploadId)) uploadId = message.payload.uploadId;
      void executeDoclingRequest(message.payload, controller.signal).then(result => {
        stopped(controller.signal); send({ kind: 'result', result });
      }).catch(error => send({ kind: 'error', error: { code: error.code || 'DOCLING_API_ERROR', name: error.name,
        message: error.message, ...(Number.isInteger(error.status) ? { status: error.status } : {}) } }));
    });
    port.onDisconnect.addListener(() => {
      disconnected = true; controller.abort();
      if (uploadId) void discardDoclingUpload(uploadId).catch(() => {});
    });
  });
}
