import browser from 'webextension-polyfill';
import { createBrowserAiEngine } from './engine.js';

const engine = createBrowserAiEngine({ wasmUrl: browser.runtime.getURL('browser-ai/wllama.wasm') });
const running = new Map();
let connection;
function connect() {
  const port = browser.runtime.connect({ name: 'paper-browser-ai-host' }); connection = port;
  const send = message => { try { port.postMessage(message); } catch (_) {} };
  port.onMessage.addListener(message => {
    if (message.kind === 'cancel') { running.get(message.id)?.abort(); return; }
    if (message.kind !== 'request' || running.has(message.id)) return;
    const controller = new AbortController(); running.set(message.id, controller);
    void engine.request(message.payload, { signal: controller.signal,
      onProgress: event => send({ kind: 'progress', id: message.id, event })
    }).then(result => send({ kind: 'result', id: message.id, result }), error => send({ kind: 'error', id: message.id,
      error: { name: error.name, code: typeof error.code === 'string' ? error.code : 'BROWSER_RUNTIME', message: error.message } }))
      .finally(() => running.delete(message.id));
  });
  port.onDisconnect.addListener(() => {
    if (connection !== port) return;
    connection = null;
    for (const controller of running.values()) controller.abort();
  });
}
browser.runtime.onMessage.addListener((request, sender) => {
  if (sender?.id !== browser.runtime.id || request.type !== 'paperBrowserAiReconnect') return false;
  if (!connection) connect();
  return Promise.resolve({ ready: true });
});
connect();
