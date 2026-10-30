jest.mock('webextension-polyfill', () => ({ runtime: { id: 'paper-extension', getURL: path => `chrome-extension://paper-extension/${path}`,
  onConnect: { addListener: jest.fn() }, getContexts: jest.fn(), sendMessage: jest.fn(), getPlatformInfo: jest.fn(async () => ({})) },
  offscreen: { createDocument: jest.fn() } }));
import browser from 'webextension-polyfill';
import { registerBrowserAiBroker } from '../src/browser_ai/broker_core.js';
const event = () => { const handlers = new Set(); return { addListener: fn => handlers.add(fn), fire: value => handlers.forEach(fn => fn(value)) }; };
const makePort = (name, path, id = 'paper-extension') => ({ name, sender: { id, url: `chrome-extension://paper-extension/${path}` },
  onMessage: event(), onDisconnect: event(), postMessage: jest.fn(), disconnect: jest.fn() });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
let accept;
beforeAll(() => { registerBrowserAiBroker(); accept = browser.runtime.onConnect.addListener.mock.calls[0][0]; });
beforeEach(() => { jest.useFakeTimers(); jest.clearAllMocks(); browser.runtime.getContexts.mockResolvedValue([]); });
afterEach(() => { expect(jest.getTimerCount()).toBe(0); jest.useRealTimers(); });

test.each(['settings.html', 'pdfjs/web/viewer.html', 'offscreen.html/other'])('only exact offscreen page can register an inference host: %s', path => {
  const port = makePort('paper-browser-ai-host', path); accept(port);
  expect(port.disconnect).toHaveBeenCalledTimes(1);
});

test.each([
  ['settings.html', 'different-extension'], ['offscreen.html', 'paper-extension'], ['popup.html', 'paper-extension'],
])('browser AI clients require exact own settings or viewer page', (path, id) => {
  const port = makePort('paper-browser-ai-client', path, id); accept(port);
  expect(port.disconnect).toHaveBeenCalledTimes(1);
  expect(browser.offscreen.createDocument).not.toHaveBeenCalled();
});

test('PDF cannot trigger model downloads or deletion through its inference client', () => {
  const port = makePort('paper-browser-ai-client', 'pdfjs/web/viewer.html'); accept(port);
  port.onMessage.fire({ kind: 'request', payload: { operation: 'prepare', model: 'translation' } });
  expect(port.postMessage).toHaveBeenCalledWith(expect.objectContaining({ kind: 'error', error: expect.objectContaining({ code: 'BROWSER_INVALID_REQUEST' }) }));
  expect(browser.offscreen.createDocument).not.toHaveBeenCalled();
  port.onDisconnect.fire();
});

test('settings boot an independent worker host without speech permission and route results', async () => {
  const client = makePort('paper-browser-ai-client', 'settings.html');
  const host = makePort('paper-browser-ai-host', 'offscreen.html');
  browser.offscreen.createDocument.mockImplementation(async () => { accept(host); });
  accept(client); client.onMessage.fire({ kind: 'request', payload: { operation: 'status' } });
  await flush();
  expect(browser.offscreen.createDocument).toHaveBeenCalledWith({ url: 'offscreen.html', reasons: ['WORKERS'], justification: expect.any(String) });
  const forwarded = host.postMessage.mock.calls[0][0];
  expect(forwarded).toMatchObject({ kind: 'request', payload: { operation: 'status' } });
  host.onMessage.fire({ kind: 'result', id: forwarded.id, result: { activeModel: null } });
  expect(client.postMessage).toHaveBeenCalledWith({ kind: 'result', id: forwarded.id, result: { activeModel: null } });
  const spoof = makePort('paper-browser-ai-host', 'pdfjs/web/viewer.html'); accept(spoof);
  expect(spoof.disconnect).toHaveBeenCalledTimes(1);
  client.onDisconnect.fire(); host.onDisconnect.fire();
});
