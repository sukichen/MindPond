import {localInferenceStatus} from './local-inference.js';
import { getEmbeddingService } from './embedding.js';
import { getZhEmbeddingService, zhEnabled } from './embedding-zh.js';

/** Read-only observations; uninitialized does not pretend a model was tested. */
export function retrievalStatus() {
  return {
    localInference:localInferenceStatus(),
    primary: getEmbeddingService().status(),
    chinese: zhEnabled() ? getZhEmbeddingService().status() : { state: 'disabled' },
    textFallback: true,
    automaticModelDownload: false,
    guidance: 'unavailable means the model could not load; text retrieval remains available. Local vectors require the explicitly installed @huggingface/transformers optional runtime and local model files. MINDPOND_EMBEDDING_MODE=text disables local inference. Restart after configuring the runtime or model files. An empty result in fallback mode does not prove no relevant memory exists.',
  };
}
