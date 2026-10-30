import { BROWSER_MODELS, BROWSER_TRANSLATION_MODEL, embeddingInput, hyMtPrompt } from './models.js';

const fail = (code, message) => Object.assign(new Error(message), { name: 'BrowserAiError', code });
const stopped = signal => { if (signal?.aborted) throw new DOMException('Stopped', 'AbortError'); };

// One queue and one resident model avoid duplicating weights for each PDF/tab.
export function createBrowserAiEngine({ wasmUrl, loadLibrary = () => import('@wllama/wllama/esm/index.js'),
  getGpu = async () => !!(await navigator.gpu?.requestAdapter()) } = {}) {
  let library, manager, cache, instance, activeModel = null, tail = Promise.resolve(), pending = 0;
  const init = async () => {
    if (!library) library = await loadLibrary();
    if (!cache) { cache = new library.CacheManager(); manager = new library.ModelManager({ cacheManager: cache, allowOffline: true }); }
  };
  const models = async () => {
    await init();
    return manager.getModels({ includeInvalid: true });
  };
  const cachedModel = (entries, model) => entries.find(entry => entry.url === model.url && entry.size === model.bytes && entry.validate() === 'valid');
  const status = async () => {
    const entries = await models();
    return { webgpu: await getGpu(), activeModel, busy: pending > 0,
      models: Object.fromEntries(Object.entries(BROWSER_MODELS).map(([kind, model]) => [kind, {
        id: model.id, name: model.name, bytes: model.bytes, cached: !!cachedModel(entries, model), loaded: activeModel === kind,
      }])) };
  };
  const unload = async () => {
    const previous = instance; instance = null; activeModel = null;
    if (previous) await previous.exit();
  };
  const load = async (kind, allowDownload, signal, onProgress) => {
    stopped(signal);
    if (!(await getGpu())) throw fail('BROWSER_GPU_UNAVAILABLE', 'WebGPU is unavailable. Use Chrome with GPU acceleration or choose the API execution option.');
    await init();
    if (activeModel === kind && instance?.isModelLoaded()) return instance;
    const model = BROWSER_MODELS[kind];
    let saved = cachedModel(await models(), model);
    if (!saved) {
      if (!allowDownload) throw fail('BROWSER_MODEL_NOT_READY', `Prepare ${model.name} in the browser AI settings first.`);
      onProgress?.({ model: kind, phase: 'download', loaded: 0, total: model.bytes, progress: 0 });
      saved = await manager.downloadModel(model.url, { signal, progressCallback: ({ loaded, total }) =>
        onProgress?.({ model: kind, phase: 'download', loaded, total, progress: total ? Math.min(1, loaded / total) : 0 }) });
      if (saved.size !== model.bytes || saved.validate() !== 'valid') {
        await saved.remove(); throw fail('BROWSER_MODEL_INVALID', 'The model download is incomplete. Prepare the model again.');
      }
    }
    stopped(signal);
    await unload(); stopped(signal);
    onProgress?.({ model: kind, phase: 'load', loaded: 0, total: 1, progress: 0 });
    const next = new library.Wllama({ default: wasmUrl }, { cacheManager: cache, modelManager: manager,
      allowOffline: true, suppressNativeLog: true });
    next.setCompat(null);
    try {
      await next.loadModel(saved, { n_ctx: model.context, n_batch: kind === 'embedding' ? 2048 : 512,
        n_ubatch: kind === 'embedding' ? 2048 : 128, n_gpu_layers: 99999, n_threads: 1, n_parallel: 1,
        embeddings: kind === 'embedding', ...(kind === 'embedding' ? { pooling_type: 'mean' } : {}),
        warmup: false, ctx_shift: false });
      stopped(signal);
      instance = next; activeModel = kind;
      onProgress?.({ model: kind, phase: 'load', loaded: 1, total: 1, progress: 1 });
      return next;
    } catch (error) { await next.exit().catch(() => {}); throw error; }
  };
  const execute = async (payload, { signal, onProgress } = {}) => {
    stopped(signal);
    if (!payload || !['status', 'prepare', 'unload', 'delete', 'chat', 'embed'].includes(payload.operation)) {
      throw fail('BROWSER_INVALID_REQUEST', 'Unknown browser AI operation.');
    }
    if (payload.operation === 'status') return status();
    if (payload.operation === 'unload') { await unload(); return status(); }
    if (['prepare', 'delete'].includes(payload.operation) && !BROWSER_MODELS[payload.model]) {
      throw fail('BROWSER_INVALID_REQUEST', 'Unknown browser AI model.');
    }
    if (payload.operation === 'delete') {
      await init();
      if (activeModel === payload.model) await unload();
      await cache.delete(BROWSER_MODELS[payload.model].url); return status();
    }
    if (payload.operation === 'prepare') { await load(payload.model, true, signal, onProgress); return status(); }
    if (payload.operation === 'chat') {
      const prompt = hyMtPrompt(payload.messages);
      if (prompt.length > 32000 || !Number.isFinite(payload.max_tokens ?? 1024) ||
          (payload.max_tokens ?? 1024) < 1 || (payload.max_tokens ?? 1024) > 4096) {
        throw fail('BROWSER_INVALID_REQUEST', 'Browser translation input or output limit is too large.');
      }
      if (!Number.isFinite(payload.temperature ?? .1) || (payload.temperature ?? .1) < 0 || (payload.temperature ?? .1) > 2 ||
          (payload.seed !== undefined && (!Number.isInteger(payload.seed) || payload.seed < 0 || payload.seed > 0x7fffffff))) {
        throw fail('BROWSER_INVALID_REQUEST', 'Invalid browser translation sampling options.');
      }
      const engine = await load('translation', false, signal, onProgress); stopped(signal);
      onProgress?.({ model: 'translation', phase: 'generate', loaded: 0, total: 1, progress: 0 });
      const response = await engine.createCompletion({ prompt, max_tokens: payload.max_tokens ?? 1024,
        temperature: payload.temperature ?? .1, ...(payload.seed == null ? {} : { seed: payload.seed }),
        top_p: .6, top_k: 20, penalty_repeat: 1.05,
        stop: ['<｜hy_place▁holder▁no▁2｜>', '<｜hy_place▁holder▁no▁8｜>'], abortSignal: signal, stream: false });
      stopped(signal);
      const choice = response?.choices?.[0];
      if (!choice || typeof choice.text !== 'string') throw fail('BROWSER_RESPONSE', 'Browser translation returned no text.');
      onProgress?.({ model: 'translation', phase: 'generate', loaded: 1, total: 1, progress: 1 });
      return { ...response, object: 'chat.completion', model: BROWSER_TRANSLATION_MODEL,
        choices: [{ ...choice, message: { role: 'assistant', content: choice.text } }] };
    }
    if (!Array.isArray(payload.input) || !payload.input.length || payload.input.length > 64 ||
        payload.input.some(text => typeof text !== 'string' || !text.trim() || text.length > 12000)) {
      throw fail('BROWSER_INVALID_REQUEST', 'Invalid browser embedding input.');
    }
    if (payload.purpose !== undefined && !['document', 'query'].includes(payload.purpose)) {
      throw fail('BROWSER_INVALID_REQUEST', 'Invalid embedding purpose.');
    }
    const engine = await load('embedding', false, signal, onProgress), vectors = [];
    for (const [index, text] of payload.input.entries()) {
      stopped(signal);
      const result = await engine.createEmbedding({ input: embeddingInput(text, payload.purpose), encoding_format: 'float', abortSignal: signal });
      stopped(signal);
      const vector = result?.data?.[0]?.embedding;
      if (!Array.isArray(vector) || vector.length !== 768 || !vector.every(Number.isFinite)) {
        throw fail('BROWSER_RESPONSE', 'Browser embedding returned an invalid vector.');
      }
      const norm = Math.hypot(...vector);
      if (!(norm > 0)) throw fail('BROWSER_RESPONSE', 'Browser embedding returned an empty vector.');
      vectors.push(vector.map(value => value / norm));
      onProgress?.({ model: 'embedding', phase: 'embed', loaded: index + 1, total: payload.input.length,
        progress: (index + 1) / payload.input.length });
    }
    return vectors;
  };
  return {
    request(payload, options = {}) {
      if (payload?.operation === 'status') return execute(payload, options);
      pending++;
      const result = tail.then(() => execute(payload, options)).catch(async error => {
        if (!error.code && !options.signal?.aborted && ['chat', 'embed'].includes(payload?.operation)) {
          await unload().catch(() => {});
        }
        throw error;
      });
      tail = result.catch(() => {}).finally(() => { pending--; });
      return result;
    },
  };
}
