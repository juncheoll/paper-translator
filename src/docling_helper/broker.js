import browser from 'webextension-polyfill';
import { DOCLING_HELPER_PORT } from './client.js';

const HOST = 'com.papertranslator.docling';
const operations = new Set(['status', 'prepare', 'start', 'stop', 'unload']);
const pending = new Map();
let nativePort, lastState, nextId = 0, registered = false;
const send = (port, message) => { try { port.postMessage(message); } catch (_) {} };
const errorData = (code, message) => ({ code, message });
const missingState = () => ({ schema: 1, installed: false, modelReady: false, running: false, managed: false, modelLoaded: null, busy: false });

function viewerKind(sender) {
  if (sender?.id !== browser.runtime.id) return null;
  try {
    const actual = new URL(sender.url), own = new URL(browser.runtime.getURL('settings.html'));
    if (actual.protocol !== own.protocol || actual.host !== own.host) return null;
    if (actual.pathname === own.pathname) return 'settings';
    if (actual.pathname === new URL(browser.runtime.getURL('pdfjs/web/viewer.html')).pathname) return 'pdf';
  } catch (_) {}
  return null;
}

function releaseIdleHost() {
  if (pending.size || !nativePort || lastState?.running && lastState?.managed) return;
  const port = nativePort;
  nativePort = null;
  try { port.disconnect(); } catch (_) {}
}

function finishRequest(id, message) {
  const request = pending.get(id);
  if (!request) return;
  pending.delete(id);
  if (message.kind === 'result') lastState = message.result;
  for (const client of request.clients) { client.id = null; send(client.port, message); }
  releaseIdleHost();
}

function failHost(port, rawMessage = '') {
  if (nativePort !== port) return;
  nativePort = null;
  const missing = /(?:native messaging host.*not found|not (?:registered|installed))/i.test(rawMessage);
  const forbidden = /forbidden|not allowed/i.test(rawMessage);
  const code = missing ? 'DOCLING_HELPER_NOT_INSTALLED' : forbidden ? 'DOCLING_HELPER_FORBIDDEN' : 'DOCLING_HELPER_DISCONNECTED';
  const message = rawMessage || 'Docling helper stopped. Retry or reinstall the helper for this extension.';
  lastState = null;
  for (const [id, request] of [...pending]) finishRequest(id,
    missing && request.operation === 'status' ? { kind: 'result', result: missingState() } :
      { kind: 'error', error: errorData(code, message) });
}

function connectHost() {
  if (nativePort) return nativePort;
  const port = browser.runtime.connectNative(HOST);
  nativePort = port;
  port.onMessage.addListener(message => {
    if (nativePort !== port || !message || typeof message.id !== 'string') return;
    const request = pending.get(message.id);
    if (!request) return;
    if (message.kind === 'progress') {
      for (const client of request.clients) send(client.port, { kind: 'progress', event: message.event });
    } else if (message.kind === 'result') finishRequest(message.id, { kind: 'result', result: message.result });
    else if (message.kind === 'error') finishRequest(message.id, { kind: 'error', error: errorData(
      typeof message.error?.code === 'string' ? message.error.code : 'DOCLING_HELPER_FAILED',
      typeof message.error?.message === 'string' ? message.error.message : 'Docling helper failed.') });
  });
  port.onDisconnect.addListener(() => {
    // Chrome exposes this value only while delivering the disconnect event.
    const message = browser.runtime.lastError?.message || globalThis.chrome?.runtime?.lastError?.message || '';
    failHost(port, message);
  });
  return port;
}

function cancelClient(client) {
  const request = pending.get(client.id);
  if (!request) return;
  request.clients.delete(client);
  if (!request.clients.size) {
    pending.delete(client.id);
    if (nativePort) send(nativePort, { operation: 'cancel', id: client.id });
  }
  client.id = null;
  releaseIdleHost();
}

export function registerDoclingHelperBroker() {
  if (registered) return;
  registered = true;
  browser.runtime.onConnect.addListener(port => {
    if (port.name !== DOCLING_HELPER_PORT) return;
    const kind = viewerKind(port.sender);
    if (!kind) { port.disconnect(); return; }
    const client = { port, id: null };
    let requested = false;
    port.onMessage.addListener(message => {
      if (message?.kind === 'cancel') { cancelClient(client); return; }
      if (message?.kind !== 'request' || requested) return;
      requested = true;
      const payload = message.payload;
      if (!payload || Object.keys(payload).some(key => key !== 'operation') || !operations.has(payload.operation) ||
          kind === 'pdf' && !['start', 'status'].includes(payload.operation)) {
        send(port, { kind: 'error', error: errorData('DOCLING_HELPER_REQUEST', 'Invalid Docling helper request.') });
        return;
      }
      const operation = payload.operation;
      const shared = ['start', 'prepare'].includes(operation) && [...pending].find(([, request]) =>
        request.operation === operation || operation === 'start' && request.operation === 'prepare');
      if (shared) { client.id = shared[0]; shared[1].clients.add(client); return; }
      const id = `docling-${++nextId}`;
      client.id = id;
      pending.set(id, { operation, clients: new Set([client]) });
      try { connectHost().postMessage({ id, operation }); }
      catch (error) {
        finishRequest(id, operation === 'status' ? { kind: 'result', result: missingState() } :
          { kind: 'error', error: errorData('DOCLING_HELPER_NOT_INSTALLED', error?.message || 'Install the Docling helper first.') });
      }
    });
    port.onDisconnect.addListener(() => cancelClient(client));
  });
}
