export const LOCAL_DOCLING_ENDPOINT = 'http://127.0.0.1:8876';
export const MAX_DOCLING_BYTES = 50 * 1024 * 1024;

export function doclingConfiguration(settings = {}) {
  const execution = settings.doclingExecution === 'server' ? 'server' : 'local';
  if (execution === 'local') return { execution, endpoint: LOCAL_DOCLING_ENDPOINT };
  try {
    const url = new URL(settings.doclingApiEndpoint);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    return { execution, endpoint: url.href.replace(/\/+$/, '').replace(/\/v1$/, '') };
  } catch (_) {
    throw Object.assign(new Error('Docling 서버 주소를 확인하세요. 예: https://example.org/docling'), { code: 'DOCLING_CONFIG' });
  }
}
