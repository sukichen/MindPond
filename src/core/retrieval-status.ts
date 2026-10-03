import { getEmbeddingService } from './embedding.js';
import { getZhEmbeddingService, zhEnabled } from './embedding-zh.js';

/** Read-only observations; uninitialized does not pretend a model was tested. */
export function retrievalStatus() {
  return {
    primary: getEmbeddingService().status(),
    chinese: zhEnabled() ? getZhEmbeddingService().status() : { state: 'disabled' },
    textFallback: true,
    automaticModelDownload: false,
    guidance: 'unavailable means the model could not load; text retrieval remains available. Configure local model files via EMBEDDING_MODEL_DIR and restart to retry. An empty result in fallback mode does not prove no relevant memory exists.',
  };
}
