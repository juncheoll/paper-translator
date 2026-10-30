import { pdfViewerUrl, validPdfSource, isLocalPdf } from './pdf_urls.js';
export function registerPdfNavigation(browser) {
  const enabled = async () => { const { pdfAutoOpen = true } = await browser.storage.local.get('pdfAutoOpen'); return pdfAutoOpen !== false && pdfAutoOpen !== 'false'; };
  browser.runtime.onMessage.addListener(async (message, sender) => {
    if (message?.type !== 'openPdf' || Object.keys(message).length !== 1 || sender?.id !== browser.runtime.id ||
        sender.frameId !== 0 || !Number.isInteger(sender.tab?.id) || !validPdfSource(sender.url)) return undefined;
    if (await enabled()) await browser.tabs.update(sender.tab.id, { url: pdfViewerUrl(browser.runtime, sender.url) });
    return { ok: true };
  });
  browser.tabs.onUpdated.addListener((tabId, changes) => {
    if (!isLocalPdf(changes.url)) return;
    void enabled().then(value => value && browser.tabs.update(tabId, { url: pdfViewerUrl(browser.runtime, changes.url) })).catch(console.error);
  });
}
