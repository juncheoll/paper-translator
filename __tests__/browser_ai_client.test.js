jest.mock('webextension-polyfill', () => ({ runtime: { connect: jest.fn() } }));
jest.mock('../src/browser_ai/broker_core', () => ({ requestInBackground: jest.fn() }));
import browser from 'webextension-polyfill';
import { requestBrowserAi } from '../src/browser_ai/client';
import { requestInBackground } from '../src/browser_ai/broker_core';

const event = () => {
  const handlers = new Set();
  return { addListener: handler => handlers.add(handler), fire: value => handlers.forEach(handler => handler(value)) };
};
let port;
beforeEach(() => {
  jest.useFakeTimers();
  port = { postMessage: jest.fn(), onMessage: event(), onDisconnect: event(), disconnect: jest.fn() };
  browser.runtime.connect.mockReturnValue(port);
});
afterEach(() => jest.useRealTimers());

test('progress and keepalive remain separate from the final completion and timers are released', async () => {
  const progress = jest.fn(), pending = requestBrowserAi({ operation: 'prepare', model: 'translation' }, { onProgress: progress });
  port.onMessage.fire({ kind: 'progress', event: { phase: 'download', progress: .5 } });
  expect(progress).toHaveBeenCalledWith({ phase: 'download', progress: .5 });
  jest.advanceTimersByTime(20000); expect(port.postMessage).toHaveBeenLastCalledWith({ kind: 'ping' });
  port.onMessage.fire({ kind: 'result', result: { ready: true } });
  await expect(pending).resolves.toEqual({ ready: true });
  expect(port.disconnect).toHaveBeenCalledTimes(1); expect(jest.getTimerCount()).toBe(0);
});

test('cancellation forwards to the host and prevents late results from replacing existing text', async () => {
  const controller = new AbortController(), pending = requestBrowserAi({ operation: 'chat' }, { signal: controller.signal });
  controller.abort();
  expect(port.postMessage).toHaveBeenLastCalledWith({ kind: 'cancel' });
  port.onMessage.fire({ kind: 'result', result: 'late' });
  await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
  expect(jest.getTimerCount()).toBe(0);
});

test('host errors and unexpected disconnections reach callers without hanging', async () => {
  const pending = requestBrowserAi({ operation: 'chat' });
  port.onMessage.fire({ kind: 'error', error: { code: 'BROWSER_MODEL_NOT_READY', message: 'Prepare first.' } });
  await expect(pending).rejects.toMatchObject({ code: 'BROWSER_MODEL_NOT_READY', message: 'Prepare first.' });
  const disconnected = requestBrowserAi({ operation: 'status' }); port.onDisconnect.fire();
  await expect(disconnected).rejects.toMatchObject({ code: 'BROWSER_DISCONNECTED' });
  expect(jest.getTimerCount()).toBe(0);
});

test('numeric DOMException codes are normalized before reaching translator error handling', async () => {
  const pending = requestBrowserAi({ operation: 'prepare', model: 'translation' });
  port.onMessage.fire({ kind: 'error', error: { code: 22, name: 'QuotaExceededError', message: 'Storage is full.' } });
  await expect(pending).rejects.toMatchObject({ code: 'BROWSER_RUNTIME', name: 'QuotaExceededError' });
});

test('background tooltip requests use the in-process broker instead of connecting to themselves', async () => {
  const previousScope = global.ServiceWorkerGlobalScope, previousSelf = global.self;
  global.ServiceWorkerGlobalScope = class {}; global.self = new global.ServiceWorkerGlobalScope();
  requestInBackground.mockResolvedValue({ choices: [] });
  try {
    await expect(requestBrowserAi({ operation: 'chat' })).resolves.toEqual({ choices: [] });
    expect(requestInBackground).toHaveBeenCalledWith({ operation: 'chat' }, expect.anything());
    expect(port.postMessage).not.toHaveBeenCalled();
  } finally { global.ServiceWorkerGlobalScope = previousScope; global.self = previousSelf; }
});
