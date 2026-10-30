export const BROWSER_TRANSLATION_MODEL = 'hy-mt2:1.8b-q8';
export const BROWSER_WLLAMA_VERSION = '3.8.1';

export const BROWSER_MODELS = {
  translation: {
    id: BROWSER_TRANSLATION_MODEL, name: 'Hy-MT2 1.8B Q8', bytes: 1908528192,
    revision: 'a0c709d9fac510f2c807aa3af52872340dc37a4a',
    url: 'https://huggingface.co/tencent/Hy-MT2-1.8B-GGUF/resolve/a0c709d9fac510f2c807aa3af52872340dc37a4a/Hy-MT2-1.8B-Q8_0.gguf',
    context: 8192,
  },
  embedding: {
    id: 'embeddinggemma', name: 'EmbeddingGemma 300M Q8', bytes: 333590944,
    revision: '0f741b5a6585bd53aeb15cd1372c56f2a0f65e12',
    url: 'https://huggingface.co/ggml-org/embeddinggemma-300M-GGUF/resolve/0f741b5a6585bd53aeb15cd1372c56f2a0f65e12/embeddinggemma-300M-Q8_0.gguf',
    context: 2048,
  },
};

export function getBrowserModelIdentity() {
  return Object.entries(BROWSER_MODELS).map(([kind, model]) => [model.id,
    `browser:wllama-${BROWSER_WLLAMA_VERSION}:${model.revision}:${kind === 'embedding' ? 'mean-l2:retrieval-prefix-v1' : 'hy-template-v1:ctx8192'}`]);
}

// Match the corrected native template; the original GGUF chat template omits user text.
export function hyMtPrompt(messages) {
  if (!Array.isArray(messages) || !messages.length || messages.some(message =>
    !['system', 'user', 'assistant'].includes(message?.role) || typeof message.content !== 'string')) {
    throw Object.assign(new Error('Invalid browser translation messages.'), { code: 'BROWSER_INVALID_REQUEST' });
  }
  const system = messages.filter(message => message.role === 'system').map(message => message.content).join('\n');
  return '<｜hy_begin▁of▁sentence｜>' + (system ? system + '<｜hy_place▁holder▁no▁3｜>' : '') +
    messages.filter(message => message.role !== 'system').map(message => message.role === 'user'
      ? '<｜hy_User｜>' + message.content
      : '<｜hy_Assistant｜>' + message.content + '<｜hy_place▁holder▁no▁2｜>').join('') + '<｜hy_Assistant｜>';
}

export function embeddingInput(text, purpose = 'document') {
  return (purpose === 'query' ? 'task: search result | query: ' : 'title: none | text: ') + text;
}
