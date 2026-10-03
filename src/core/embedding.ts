/**
 * Embedding Service — 本地轻量 ONNX 模型（@huggingface/transformers）
 *
 * 使用 all-MiniLM-L6-v2 模型（384维，~23MB），进程内运行，无需外部服务。
 * 从配置的本地模型目录加载；不自动下载。缺失时降级为文本检索。
 *
 * 可通过环境变量自定义：
 *   EMBEDDING_MODEL   — HuggingFace 模型名（默认 Xenova/all-MiniLM-L6-v2）
 *   EMBEDDING_DIMS    — 向量维度（默认 384）
 *
 * 当模型加载失败时返回空向量（[]）——写入路径的 `length > 0` 检查会将其
 * 视为"无向量"（存 NULL、不入索引），系统自动降级为纯 ngram 文本搜索。
 * 注意：绝不能返回零向量——它 length>0 会骗过检查入库，污染向量索引。
 */

import path from 'node:path';
import { defaultModelDirectory } from './runtime-paths.js';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '../infra/errors.js';
import { createHash } from 'node:crypto';
import { createModuleLogger } from '../infra/logger.js';

const logger = createModuleLogger('embedding');

/**
 * 本地模型目录（server/models）。
 * 网络受限无法访问 HuggingFace，模型文件预先从 ModelScope 下载到此目录。
 * 目录结构：<models>/<org>/<model>/...（与 HF 仓库布局一致）
 */
const MODELS_DIR = defaultModelDirectory(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'models'));

export interface EmbeddingOptions {
  /** HuggingFace 模型名称 */
  model?: string;
  /** 向量维度 */
  dimensions?: number;
}

// 延迟加载 pipeline，避免阻塞模块加载
let pipelinePromise: Promise<any> | null = null;

async function getPipeline(model: string) {
  if (!pipelinePromise) {
    pipelinePromise = import('@huggingface/transformers').then(({ pipeline, env }) => {
      // 网络受限：只从本地 models/ 目录加载，禁止远程下载
      env.localModelPath = MODELS_DIR;
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      return pipeline('feature-extraction', model, {dtype:'q8',device:'cpu'});
    }).catch((err) => {
      pipelinePromise = null; // 失败则下次重试
      throw err;
    });
  }
  return pipelinePromise;
}

export class EmbeddingService {
  status() {
    return { model: this.modelName, state: this.ready ? 'ready' : this.loadFailed ? 'unavailable' : 'uninitialized' };
  }
  private modelName: string;
  private dimensions: number;
  private ready = false;
  private loadFailed = false;
  /**
   * 有界 LRU 缓存。
   * Node 单线程，无需额外同步。
   */
  private cache = new Map<string, number[]>();
  private readonly CACHE_CAPACITY = 500;

  constructor(options: EmbeddingOptions = {}) {
    this.modelName = options.model || process.env.EMBEDDING_MODEL || 'Xenova/all-MiniLM-L6-v2';
    this.dimensions = options.dimensions || parseInt(process.env.EMBEDDING_DIMS || '384', 10);
  }

  /** 读取缓存并刷新 LRU 位置 */
  private cacheGet(text: string): number[] | undefined {
    const vec = this.cache.get(text);
    if (vec) {
      this.cache.delete(text);
      this.cache.set(text, vec);
    }
    return vec;
  }

  /** 写入缓存，超出容量时淘汰最久未使用的条目 */
  private cacheSet(text: string, vec: number[]): void {
    if (this.cache.has(text)) this.cache.delete(text);
    this.cache.set(text, vec);
    if (this.cache.size > this.CACHE_CAPACITY) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  /**
   * 确保模型已加载
   */
  private async ensureLoaded(): Promise<boolean> {
    if (this.ready) return true;
    if (this.loadFailed) return false;

    try {
      const pipe = await getPipeline(this.modelName);
      // 触发一次推理确保模型完全加载
      await pipe('warmup', { pooling: 'mean', normalize: true });
      this.ready = true;
      logger.info(`Local embedding model loaded: ${this.modelName}`);
      return true;
    } catch (err: unknown) {
      this.loadFailed = true;
      logger.warn(`Failed to load embedding model (${this.modelName}): ${getErrorMessage(err)}. Falling back to ngram-only search.`);
      return false;
    }
  }

  /**
   * 生成文本向量（本地推理，无网络调用）
   * 模型不可用/推理失败时返回空数组 []，不抛异常。
   */
  async generateEmbedding(text: string): Promise<number[]> {
    const cached = this.cacheGet(text);
    if (cached) return cached;

    if (!(await this.ensureLoaded())) {
      return [];
    }

    try {
      const pipe = await getPipeline(this.modelName);
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      const vec: number[] = Array.from(output.data as Float32Array);
      this.cacheSet(text, vec);
      return vec;
    } catch (err: unknown) {
      logger.warn(`Embedding inference failed: ${getErrorMessage(err)}`);
      return [];
    }
  }

  /**
   * 批量生成向量（不可用的条目返回 null）
   */
  async generateBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];

    if (!(await this.ensureLoaded())) {
      return texts.map(() => null);
    }

    const results: (number[] | null)[] = [];
    for (const text of texts) {
      try {
        const vec = await this.generateEmbedding(text);
        results.push(vec.length > 0 ? vec : null);
      } catch {
        results.push(null);
      }
    }
    return results;
  }

  /**
   * 计算余弦相似度
   */
  cosineSimilarity(vecA: number[], vecB: number[]): number {
    if (vecA.length !== vecB.length) {
      throw new Error('Vector dimensions must match');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vecA.length; i++) {
      dotProduct += vecA[i] * vecB[i];
      normA += vecA[i] * vecA[i];
      normB += vecB[i] * vecB[i];
    }

    if (normA === 0 || normB === 0) {
      return 0;
    }

    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  /**
   * 测试模型是否可用
   */
  async testConnection(): Promise<boolean> {
    return this.ensureLoaded();
  }

  /**
   * 获取当前模型名称
   */
  getModelName(): string {
    return this.modelName;
  }
  getDimensions(){return this.dimensions;}
}
export function legacyEmbeddingIdentity(){
  const service=getEmbeddingService();
  return createHash('sha256').update(JSON.stringify({model:service.getModelName(),dimensions:service.getDimensions(),pooling:'mean',dtype:'q8'})).digest('hex');
}
export function acceptsUnlabelledLegacyVectors(){const service=getEmbeddingService();return service.getModelName()==='Xenova/all-MiniLM-L6-v2'&&service.getDimensions()===384;}

// 导出单例
let embeddingInstance: EmbeddingService | null = null;

export const getEmbeddingService = (options?: EmbeddingOptions): EmbeddingService => {
  if (!embeddingInstance) {
    embeddingInstance = new EmbeddingService(options);
  }
  return embeddingInstance;
};
