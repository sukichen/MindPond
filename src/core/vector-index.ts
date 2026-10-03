import { createHash } from 'node:crypto';
/**
 * Vector Index - 多维向量索引服务
 * 
 * 功能：
 * 1. 支持多分类维度独立向量字段
 * 2. 动态权重加权检索
 * 3. 构建向量索引（内存版暴力扫描 + 缓存）
 * 4. 加速向量相似度搜索
 * 5. 支持增量更新
 * 6. 缓存热门查询结果
 */

import { createModuleLogger } from '../infra/logger.js';
import { getMetricsCollector } from '../infra/monitoring/metrics.js';
import type { Dimension } from './graph-memory.js';

const logger = createModuleLogger('vector-index');

// ============================================
// 类型定义
// ============================================

export interface VectorItem {
  id: string;
  vector: number[] | Float32Array;
  metadata?: {
    uri?: string;
    dimensions?: Dimension[];
    l2?: string;
    importance?: number;
    [key: string]: any;
  };
  // 新增：分类维度向量（多字段支持）
  dimensionVectors?: Partial<Record<Dimension, number[]>>;
}

export interface SearchOptions {
  topK: number;
  minScore?: number;
  // 新增：分类维度权重
  dimensionWeights?: Partial<Record<Dimension, number>>;
  /** Eligibility must be applied before topK truncation. */
  filter?: (item: VectorItem) => boolean;
  /** Stable representation of filter semantics for the result cache. */
  filterKey?: string;
}

export interface SearchResult {
  id: string;
  score: number;
  metadata?: any;
  // 新增：各维度得分详情
  dimensionScores?: Partial<Record<Dimension, number>>;
}

// 多字段搜索结果
export interface MultiFieldSearchResult extends SearchResult {
  fieldScores: Record<string, number>;  // 各向量字段得分
  finalScore: number;  // 加权后最终得分
}

// ============================================
// 余弦相似度计算
// ============================================

export function cosineSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dotProduct = 0;
  let normA = 0;
  let normB = 0;
  
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  
  if (normA === 0 || normB === 0) return 0;
  
  return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

// ============================================
// 向量索引类
// ============================================

export class VectorIndex {
  private items: Map<string, VectorItem> = new Map();
  private cache: Map<string, { results: SearchResult[]; timestamp: number }> = new Map();
  private readonly CACHE_MAX_SIZE = 1000;
  private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 分钟
  private _cacheHits: number = 0;
  private _cacheMisses: number = 0;
  private _dirtyCount: number = 0;

  /**
   * 添加向量项
   */
  private pack(item:VectorItem):VectorItem {
    let norm=0;for(const value of item.vector)norm+=value*value;
    norm=Math.sqrt(norm);
    const vector=Float32Array.from(item.vector,value=>norm?value/norm:0);
    return {...item,vector};
  }
  add(item: VectorItem): void {
    this.items.set(item.id, this.pack(item));
    this.markDirty();
    logger.debug(`VectorIndex: added item ${item.id}, total: ${this.items.size}`);
  }

  /**
   * 批量添加向量项
   */
  addBatch(items: VectorItem[]): void {
    for (const item of items) {
      this.items.set(item.id, this.pack(item));
    }
    this.markDirty(items.length);
    logger.info(`VectorIndex: added ${items.length} items, total: ${this.items.size}`);
  }

  /**
   * 移除向量项
   *
   * 增量失效：只清除结果中包含被删向量 id 的缓存项，
   * 而非每次 remove 都全量清空缓存。
   */
  remove(id: string): boolean {
    const deleted = this.items.delete(id);
    if (deleted) {
      this.invalidateCacheForItem(id);
    }
    return deleted;
  }

  /**
   * 向量搜索（优化版：带缓存 + TTL 检查）
   */
  search(queryVector: number[] | Float32Array, options: SearchOptions): SearchResult[] {
    const startTime = Date.now();
    const cacheKey = this.getCacheKey(queryVector, options);

    // 检查缓存（含 TTL 过期判断）
    const cacheable=!options.filter || options.filterKey!==undefined;
    const cached = cacheable ? this.cache.get(cacheKey) : undefined;
    if (cached) {
      if (Date.now() - cached.timestamp < this.CACHE_TTL_MS) {
        this._cacheHits++;
        logger.debug('VectorIndex: cache hit');
        getMetricsCollector().recordMemoryRetrieval(Date.now() - startTime, 'vector', true);
        return cached.results;
      }
      // Expired — remove
      this.cache.delete(cacheKey);
    }
    this._cacheMisses++;

    // 如果有分类维度权重，使用多字段搜索
    if (options.dimensionWeights && Object.keys(options.dimensionWeights).length > 0) {
      const results = this.searchWithWeights(queryVector, options);
      if(cacheable)this.updateCache(cacheKey, results);
      getMetricsCollector().recordMemoryRetrieval(Date.now() - startTime, 'vector', false);
      return results;
    }
    
    // 执行传统搜索
    const results: SearchResult[] = [];
    
    let normSquared=0;for(const v of queryVector)normSquared+=v*v;
    const queryNorm=Math.sqrt(normSquared);
    const normalized=Float64Array.from(queryVector,v=>queryNorm?v/queryNorm:0);
    for (const [id, item] of this.items.entries()) {
      if (options.filter && !options.filter(item)) continue;
      // Stored vectors are normalized once; no per-candidate square roots.
      let score=0;
      if(normalized.length===item.vector.length)for(let i=0;i<normalized.length;i++)score+=normalized[i]*item.vector[i];
      else score=cosineSimilarity(queryVector,item.vector);
      
      if (options.minScore === undefined || score >= options.minScore) {
        results.push({
          id,
          score,
          metadata: item.metadata
        });
      }
    }
    
    // 排序并截取 topK
    results.sort((a, b) => b.score - a.score);
    const topResults = results.slice(0, options.topK);
    
    // 更新缓存
    if(cacheable)this.updateCache(cacheKey, topResults);
    
    logger.debug(`VectorIndex: searched ${this.items.size} items, returned ${topResults.length} results`);

    getMetricsCollector().recordMemoryRetrieval(Date.now() - startTime, 'vector', false);

    return topResults;
  }

  /**
   * 多字段加权搜索（支持分类维度动态权重）
   */
  searchWithWeights(
    queryVector: number[] | Float32Array,
options: SearchOptions
  ): MultiFieldSearchResult[] {
    const results: MultiFieldSearchResult[] = [];
    const dimensions: string[] = Object.keys(options.dimensionWeights??{});
    
    for (const [id, item] of this.items.entries()) {
      if (options.filter && !options.filter(item)) continue;
      const fieldScores: Record<string, number> = {};
      let weightedScore = 0;
      let totalWeight = 0;
      
      // 计算各分类维度得分
      for (const dim of dimensions) {
        const dimKey = dim as Dimension;
        const dimWeights = options.dimensionWeights;
        const weight = dimWeights && dimWeights[dimKey] ? dimWeights[dimKey] : 0;
        if (weight === 0) continue;

        const dimVector = item.dimensionVectors?.[dimKey];
        if (!dimVector) continue;
        
        const score = cosineSimilarity(queryVector, dimVector);
        fieldScores[dim] = score;
        weightedScore += score * (weight || 0);
        totalWeight += weight as number;
      }
      
      // 如果没有维度向量，使用主向量
      if (Object.keys(fieldScores).length === 0 && item.vector) {
        const baseScore = cosineSimilarity(queryVector, item.vector);
        weightedScore = baseScore;
        totalWeight = 1;
      }
      
      // 归一化最终得分
      const finalScore = totalWeight > 0 ? weightedScore / totalWeight : 0;
      
      if (options.minScore === undefined || finalScore >= options.minScore) {
        results.push({
          id,
          score: finalScore,
          metadata: item.metadata,
          dimensionScores: fieldScores as Partial<Record<Dimension, number>>,
          fieldScores,
          finalScore
        });
      }
    }
    
    // 按最终得分排序
    results.sort((a, b) => b.finalScore - a.finalScore);
    
    // 截取 topK
    const topResults = results.slice(0, options.topK);
    
    logger.debug(`VectorIndex: multi-field search, searched ${this.items.size} items, returned ${topResults.length} results`);
    
    return topResults;
  }

  /**
   * 获取所有向量项
   */
  getAll(): VectorItem[] {
    return Array.from(this.items.values());
  }

  get(id: string): VectorItem | undefined {
    return this.items.get(id);
  }

  /**
   * 获取统计信息
   */
  getStats(): {
    totalItems: number;
    cacheSize: number;
    cacheHits: number;
    cacheMisses: number;
    cacheHitRate: number;
  } {
    const totalLookups = this._cacheHits + this._cacheMisses;
    return {
      totalItems: this.items.size,
      cacheSize: this.cache.size,
      cacheHits: this._cacheHits,
      cacheMisses: this._cacheMisses,
      cacheHitRate: totalLookups > 0 ? this._cacheHits / totalLookups : 0
    };
  }

  /**
   * 清空索引
   */
  clear(): void {
    this.items.clear();
    this.clearCache();
    logger.info('VectorIndex: cleared all items');
  }

  /**
   * 生成缓存键（使用完整向量的 hash 避免碰撞）
   */
  private getCacheKey(vector: number[] | Float32Array, options: SearchOptions): string {
    const hash=createHash('sha256').update(Buffer.from(Float64Array.from(vector).buffer)).digest('hex');
    const weights = options.dimensionWeights ? JSON.stringify(options.dimensionWeights) : '';
    return `${hash}_${vector.length}_${options.topK}_${options.minScore ?? '0'}_${weights}_${options.filterKey ?? ''}`;
  }

  /**
   * 更新缓存（带时间戳）
   */
  private updateCache(key: string, results: SearchResult[]): void {
    // 清理过期缓存
    if (this.cache.size > this.CACHE_MAX_SIZE) {
      const now = Date.now();
      for (const [k, v] of this.cache) {
        if (now - v.timestamp > this.CACHE_TTL_MS) this.cache.delete(k);
      }
      // Still too large? clear all
      if (this.cache.size > this.CACHE_MAX_SIZE) this.cache.clear();
    }
    
    this.cache.set(key, { results, timestamp: Date.now() });
  }

  /**
   * 标记缓存为脏（add/addBatch 调用）。
   * 新向量可能改变任意查询的排名，因此立即清空缓存。
   */
  private markDirty(_count: number = 1): void {
    // Read-after-write is a memory-system invariant. A cached miss must never
    // hide a just-saved fact for five minutes.
    this.clearCache();
  }

  /**
   * 增量失效：只清除结果中包含指定 id 的缓存项。
   * 用于 remove 操作，避免全量清空缓存。
   */
  private invalidateCacheForItem(id: string): void {
    for (const [key, entry] of this.cache) {
      if (entry.results.some(r => r.id === id)) {
        this.cache.delete(key);
      }
    }
  }

  /**
   * 清空缓存
   */
  private clearCache(): void {
    this.cache.clear();
    this._dirtyCount = 0;
  }
}

// ============================================
// 批量向量操作工具
// ============================================

export class VectorBatchBuilder {
  private items: VectorItem[] = [];

  add(id: string, vector: number[], metadata?: any): this {
    this.items.push({ id, vector, metadata });
    return this;
  }

  build(): VectorItem[] {
    return this.items;
  }

  async buildFromEmbeddings(
    ids: string[],
    texts: string[],
    getEmbedding: (text: string) => Promise<number[]>
  ): Promise<VectorBatchBuilder> {
    for (let i = 0; i < ids.length; i++) {
      const embedding = await getEmbedding(texts[i]);
      this.add(ids[i], embedding);
    }
    return this;
  }
}

// ============================================
// 导出单例
// ============================================

let globalVectorIndex: VectorIndex | null = null;

export function getVectorIndex(): VectorIndex {
  if (!globalVectorIndex) {
    globalVectorIndex = new VectorIndex();
  }
  return globalVectorIndex;
}
