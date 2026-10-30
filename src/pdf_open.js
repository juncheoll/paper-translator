import browser from 'webextension-polyfill';
// Detect PDF MIME only; ordinary page text is never inspected or translated.
if (window.top === window && document.contentType === 'application/pdf') {
  void browser.runtime.sendMessage({ type: 'openPdf' }).catch(console.error);
}
