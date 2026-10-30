import browser from 'webextension-polyfill';

let host, creating;
const clients = new Map(), waiting = new Set();
const errorData = error => ({ name: error.name, code: typeof error.code === 'string' ? error.code : 'BROWSER_RUNTIME', message: error.message });
const send = (port, message) => { try { port.postMessage(message); } catch (_) {} };

async function ensureHost() {
  if (host) return host;
  if (creating) return creating;
  creating = (async () => {
    const ready = new Promise((resolve, reject) => {
      const waiter = { resolve, reject }; waiting.add(waiter);
      waiter.timer = setTimeout(() => { waiting.delete(waiter); reject(new Error('Browser AI could not start. Reload the extension and retry.')); }, 20000);
    });
    try {
      if (!browser.offscreen?.createDocument) throw new Error('Browser AI requires Chrome with offscreen document support.');
      const contexts = await browser.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
      if (!contexts.length) {
        try {
          await browser.offscreen.createDocument({ url: 'offscreen.html', reasons: ['WORKERS'],
            justification: 'Run bundled PDF translation and embedding workers.' });
        } catch (error) {
          if (!String(error.message).includes('single offscreen')) throw error;
        }
      } else void browser.runtime.sendMessage({ type: 'paperBrowserAiReconnect' }).catch(() => {});
      return await ready;
    } catch (error) {
      for (const waiter of waiting) { clearTimeout(waiter.timer); waiter.reject(error); } waiting.clear();
      // The ready rejection is consumed even if creating the document itself failed.
      await ready.catch(() => {}); throw error;
    }
  })();
  try { return await creating; } finally { creating = null; }
}

function trustedPage(sender, allowed) {
  if (sender?.id !== browser.runtime.id) return false;
  try {
    const actual = new URL(sender.url), expected = new URL(browser.runtime.getURL('offscreen.html'));
    return actual.protocol === expected.protocol && actual.host === expected.host && allowed.includes(actual.pathname);
  } catch (_) { return false; }
}

let registered = false;
export function registerBrowserAiBroker() {
 if (registered) return; registered = true;
 browser.runtime.onConnect.addListener(port => {
  if (!['paper-browser-ai-host', 'paper-browser-ai-client'].includes(port.name)) return;
  if (port.name === 'paper-browser-ai-host') {
    if (!trustedPage(port.sender, ['/offscreen.html'])) { port.disconnect(); return; }
    if (host && host !== port) { port.disconnect(); return; }
    host = port;
    for (const waiter of waiting) { clearTimeout(waiter.timer); waiter.resolve(port); } waiting.clear();
    port.onMessage.addListener(message => {
      if (message.kind === 'ping') return;
      const client = clients.get(message.id);
      if (!client) return;
      send(client.port, message);
      if (['result', 'error'].includes(message.kind)) clients.delete(message.id);
    });
    port.onDisconnect.addListener(() => {
      if (host !== port) return; host = null;
      for (const client of clients.values()) send(client.port, { kind: 'error', error: errorData(new Error('Browser AI stopped. Retry the request.')) });
      clients.clear();
    });
    return;
  }
  if (!trustedPage(port.sender, ['/pdfjs/web/viewer.html', '/settings.html'])) { port.disconnect(); return; }
  const settingsPage = new URL(port.sender.url).pathname === '/settings.html';
  let id, disconnected = false;
  port.onMessage.addListener(message => {
    if (message.kind === 'ping') return;
    if (message.kind === 'cancel') { if (id && host) send(host, { kind: 'cancel', id }); return; }
    if (message.kind !== 'request' || id) return;
    if (!settingsPage && !['status', 'chat', 'embed'].includes(message.payload?.operation)) {
      send(port, { kind: 'error', error: errorData(Object.assign(new Error('Prepare models in settings first.'), { code: 'BROWSER_INVALID_REQUEST' })) });
      return;
    }
    id = crypto.randomUUID(); clients.set(id, { port });
    void ensureHost().then(target => {
      if (!disconnected && clients.has(id)) send(target, { kind: 'request', id, payload: message.payload });
    }).catch(error => { clients.delete(id); send(port, { kind: 'error', error: errorData(error) }); });
  });
  port.onDisconnect.addListener(() => {
    disconnected = true;
    if (id && clients.has(id)) { clients.delete(id); if (host) send(host, { kind: 'cancel', id }); }
  });
 });
}

// A service worker cannot connect a runtime Port back to its own listener.
export function requestInBackground(payload, { signal, onProgress } = {}) {
  if (signal?.aborted) return Promise.reject(new DOMException('Stopped', 'AbortError'));
  return new Promise((resolve, reject) => {
    const id = crypto.randomUUID();
    let done = false;
    const finish = (error, result) => {
      if (done) return; done = true;
      clearInterval(keepalive); clients.delete(id); signal?.removeEventListener('abort', abort);
      error ? reject(error) : resolve(result);
    };
    const abort = () => { if (host) send(host, { kind: 'cancel', id }); finish(new DOMException('Stopped', 'AbortError')); };
    const keepalive = setInterval(() => { void browser.runtime.getPlatformInfo().catch(() => {}); }, 20000);
    clients.set(id, { port: { postMessage(message) {
      if (message.kind === 'progress') onProgress?.(message.event);
      else if (message.kind === 'result') finish(null, message.result);
      else if (message.kind === 'error') finish(Object.assign(new Error(message.error.message), { name: message.error.name, code: message.error.code }));
    } } });
    signal?.addEventListener('abort', abort, { once: true });
    void ensureHost().then(target => {
      if (!done) send(target, { kind: 'request', id, payload });
    }).catch(error => finish(error));
    if (signal?.aborted) abort();
  });
}
