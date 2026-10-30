export function pdfViewerUrl(runtime, file = '') {
  const url = new URL(runtime.getURL('pdfjs/web/viewer.html'));
  url.searchParams.set('file', file);
  return url.href;
}
export function validPdfSource(value) {
  try { const url = new URL(value); return ['https:', 'http:', 'file:'].includes(url.protocol) && !url.username && !url.password; }
  catch (_) { return false; }
}
export function isLocalPdf(value) {
  try { const url = new URL(value); return url.protocol === 'file:' && /\.pdf$/i.test(url.pathname); }
  catch (_) { return false; }
}
