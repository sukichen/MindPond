/**
 * Embedding Service (ZH) — 轻量中文向量模型（旁路通道，纯加法设计）
 *
 * 模型: Xenova/bge-small-zh-v1.5（512 维，~24MB 量化 ONNX，BertModel）
 * 与主 embedding.ts（all-MiniLM-L6-v2, 384 维英文模型）完全并行：
 *   - 主模型及其全部行为零改动
 *   - 本服务只在 EMBEDDING_ZH_ENABLED 开启时被调用
 *   - 中文向量存旁路表 nodes_zh（不动 nodes.embedding 列）
 *   - 检索时中文查询额外走 zh-ANN，与主 ANN 结果按 id 取 max 合并
 *
 * 配置:
 *   EMBEDDING_ZH_ENABLED — '1'/'true' 启用（默认关闭，关闭时系统行为与改动前完全一致）
 *   EMBEDDING_ZH_MODEL   — 模型名（默认 Xenova/bge-small-zh-v1.5）
 *   EMBEDDING_ZH_DIMS    — 向量维度（默认 512）
 *
 * 注意: bge 官方建议 s2p 检索给 query 加指令前缀，但本场景是句对句相似
 * （memory node vs query），不加前缀；区分度以 scripts 验证脚本实测为准。
 * env 读取全部懒求值（避免模块级 const + loadDotEnv 懒加载的静默 fallback 陷阱）。
 */

import path from 'node:path';
import { defaultModelDirectory } from './runtime-paths.js';
import { fileURLToPath } from 'node:url';
import { getErrorMessage } from '../infra/errors.js';
import { createHash } from 'node:crypto';
import { createModuleLogger } from '../infra/logger.js';

const logger = createModuleLogger('embedding-zh');

const MODELS_DIR = defaultModelDirectory(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'models'));

/** 开关：懒求值，默认关闭 */
export function zhEnabled(): boolean {
  const v = (process.env.EMBEDDING_ZH_ENABLED || '').toLowerCase();
  return v === '1' || v === 'true';
}

export function zhDims(): number {
  return parseInt(process.env.EMBEDDING_ZH_DIMS || '512', 10);
}

/**
 * 判断文本是否以中文为主（CJK 字符占比 ≥ 25%，按非空白字符计）。
 * 用于决定哪些内容需要写入 zh 旁路索引、哪些查询走 zh-ANN。
 * 中英混排（如"板子支持 fsreport 指令"）CJK 占比过半，会命中。
 */
export function isChineseText(text: string): boolean {
  if (!text) return false;
  const chars = Array.from(text.replace(/\s+/g, ''));
  if (chars.length === 0) return false;
  let cjk = 0;
  for (const ch of chars) {
    const c = ch.codePointAt(0)!;
    if ((c >= 0x4e00 && c <= 0x9fff) || (c >= 0x3400 && c <= 0x4dbf) || (c >= 0x3000 && c <= 0x303f)) cjk++;
  }
  return cjk / chars.length >= 0.25;
}

let zhPipelinePromise: Promise<any> | null = null;

async function getZhPipeline(model: string) {
  if (!zhPipelinePromise) {
    zhPipelinePromise = import('@huggingface/transformers').then(({ pipeline, env }) => {
      env.localModelPath = MODELS_DIR;
      env.allowLocalModels = true;
      env.allowRemoteModels = false;
      return pipeline('feature-extraction', model, {dtype:'q8',device:'cpu'});
    }).catch((err) => {
      zhPipelinePromise = null; // 失败则下次重试
      throw err;
    });
  }
  return zhPipelinePromise;
}

export class ZhEmbeddingService {
  status() {
    return { model: this.modelName, state: this.ready ? 'ready' : this.loadFailed ? 'unavailable' : 'uninitialized' };
  }
  private modelName: string;
  private ready = false;
  private loadFailed = false;
  private cache = new Map<string, number[]>();
  private readonly CACHE_CAPACITY = 500;

  constructor(model?: string) {
    this.modelName = model || process.env.EMBEDDING_ZH_MODEL || 'Xenova/bge-small-zh-v1.5';
  }

  private cacheGet(key: string): number[] | undefined {
    const v = this.cache.get(key);
    if (v !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, v); // LRU touch
    }
    return v;
  }

  private cacheSet(key: string, value: number[]): void {
    this.cache.set(key, value);
    if (this.cache.size > this.CACHE_CAPACITY) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  private async ensureLoaded(): Promise<boolean> {
    if (this.ready) return true;
    if (this.loadFailed) return false;
    try {
      const pipe = await getZhPipeline(this.modelName);
      await pipe('预热', { pooling: 'mean', normalize: true });
      this.ready = true;
      logger.info(`ZH embedding model loaded: ${this.modelName} (${zhDims()}d)`);
      return true;
    } catch (err: unknown) {
      this.loadFailed = true;
      logger.warn(`Failed to load ZH embedding model (${this.modelName}): ${getErrorMessage(err)}. ZH vector channel disabled.`);
      return false;
    }
  }

  /** 生成中文向量；模型不可用/推理失败返回 []，不抛异常 */
  async generateEmbedding(text: string): Promise<number[]> {
    if (!text) return [];
    const cached = this.cacheGet(text);
    if (cached) return cached;
    if (!(await this.ensureLoaded())) return [];
    try {
      const pipe = await getZhPipeline(this.modelName);
      const output = await pipe(text, { pooling: 'mean', normalize: true });
      const vec: number[] = Array.from(output.data as Float32Array);
      this.cacheSet(text, vec);
      return vec;
    } catch (err: unknown) {
      logger.warn(`ZH embedding inference failed: ${getErrorMessage(err)}`);
      return [];
    }
  }

  async generateBatch(texts: string[]): Promise<(number[] | null)[]> {
    if (texts.length === 0) return [];
    if (!(await this.ensureLoaded())) return texts.map(() => null);
    const results: (number[] | null)[] = [];
    for (const text of texts) {
      const vec = await this.generateEmbedding(text);
      results.push(vec.length > 0 ? vec : null);
    }
    return results;
  }

  async testConnection(): Promise<boolean> {
    return this.ensureLoaded();
  }

  getModelName(): string {
    return this.modelName;
  }
}

let zhInstance: ZhEmbeddingService | null = null;
export function legacyZhEmbeddingIdentity(){return createHash('sha256').update(JSON.stringify({model:getZhEmbeddingService().getModelName(),dimensions:zhDims(),pooling:'mean',dtype:'q8'})).digest('hex');}
export function acceptsUnlabelledZhVectors(){return getZhEmbeddingService().getModelName()==='Xenova/bge-small-zh-v1.5'&&zhDims()===512;}

export const getZhEmbeddingService = (): ZhEmbeddingService => {
  if (!zhInstance) zhInstance = new ZhEmbeddingService();
  return zhInstance;
};
