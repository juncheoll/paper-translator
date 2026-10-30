import browser from 'webextension-polyfill';
import { pdfViewerUrl, validPdfSource } from './pdf_urls.js';
const error = document.getElementById('error');
function showError(value) { error.hidden = false; error.textContent = value?.message || String(value); }
async function open(file = '') {
  if (file && !validPdfSource(file)) throw new Error('HTTP·HTTPS PDF 주소 또는 로컬 PDF 파일을 사용하세요.');
  await browser.tabs.create({ url: pdfViewerUrl(browser.runtime, file) });
  window.close();
}
document.getElementById('current').addEventListener('click', async () => {
  try {
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    if (tab?.url?.startsWith(browser.runtime.getURL('pdfjs/web/viewer.html'))) { window.close(); return; }
    if (!validPdfSource(tab?.url)) throw new Error('PDF를 연 탭에서 실행하거나 PDF 주소를 입력하세요.');
    await open(tab.url);
  } catch (value) { showError(value); }
});
document.getElementById('file').addEventListener('click', () => { void open().catch(showError); });
document.getElementById('urlForm').addEventListener('submit', event => { event.preventDefault(); void open(document.getElementById('url').value.trim()).catch(showError); });
document.getElementById('settings').addEventListener('click', () => { void browser.runtime.openOptionsPage().catch(showError); });
document.getElementById('help').addEventListener('click', () => { void browser.tabs.create({ url: browser.runtime.getURL('help.html') }).catch(showError); });
