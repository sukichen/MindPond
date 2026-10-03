/**
 * Performance Metrics Collection - 性能指标收集
 * 
 * 功能:
 * - API 响应时间监控
 * - LLM 调用统计
 * - 记忆检索性能
 * - 任务执行成功率
 * - 系统资源使用
 */

import { EventEmitter } from 'events';
import { monitorEventLoopDelay, type IntervalHistogram } from 'perf_hooks';
import { createModuleLogger } from '../logger.js';

const logger = createModuleLogger('monitor');

// ============================================
// 类型定义
// ============================================

export interface MetricPoint {
  timestamp: number;
  value: number;
  labels?: Record<string, string>;
}

export interface APIMetrics {
  requestCount: Map<string, number>;        // 按端点统计的请求数
  responseTime: Map<string, number[]>;      // 按端点统计的响应时间
  errorCount: Map<string, number>;          // 按端点统计的错误数
}

export interface LLMMetrics {
  callCount: number;                        // LLM 调用次数
  totalTokens: number;                      // 总 token 消耗
  averageLatency: number;                   // 平均延迟
  successRate: number;                      // 成功率
  costEstimate: number;                     // 成本估算
  cacheHitTokens: number;                   // 缓存命中 token 累计
  cacheTotalPromptTokens: number;           // prompt token 累计（用于算命中率）
}

export interface MemoryMetrics {
  retrievalCount: number;                   // 检索次数
  averageRetrievalTime: number;             // 平均检索时间
  cacheHitRate: number;                     // 缓存命中率
  memoryLayerUsage: Map<string, number>;    // 各层记忆使用
}

export interface ExecutionMetrics {
  taskCount: number;                        // 任务总数
  successCount: number;                     // 成功任务数
  failureCount: number;                     // 失败任务数
  averageExecutionTime: number;             // 平均执行时间
  retryCount: number;                       // 重试次数
}

export interface SystemMetrics {
  memoryUsage: {                            // 内存使用
    heapUsed: number;
    heapTotal: number;
    rss: number;
  };
  cpuUsage: number;                         // CPU 使用率
  eventLoopDelay: number;                   // 事件循环延迟
  activeConnections: number;                // 活跃连接数
}

export interface AlertConfig {
  metric: string;
  threshold: number;
  operator: '>' | '<' | '>=' | '<=' | '==';
  windowMs: number;                         // 检测窗口 (毫秒)
  severity: 'warning' | 'error' | 'critical';
  message: string;
}

export interface AlertEvent {
  timestamp: number;
  metric: string;
  currentValue: number;
  threshold: number;
  severity: 'warning' | 'error' | 'critical';
  message: string;
}

// ============================================
// 指标收集器
// ============================================

export class MetricsCollector extends EventEmitter {
  private apiMetrics: APIMetrics;
  private llmMetrics: LLMMetrics;
  private memoryMetrics: MemoryMetrics;
  private executionMetrics: ExecutionMetrics;
  
  private readonly MAX_DATA_POINTS = 1000;  // 每个指标最大数据点数
  private dataPoints: Map<string, MetricPoint[]> = new Map();
  
  // 事件循环延迟监测
  private eventLoopHistogram: IntervalHistogram;
  
  // 活跃连接数提供者（由外部 WebSocket 服务器注册）
  private connectionCountProvider: (() => number) | null = null;
  
  // 定时器跟踪（用于清理）
  private timers: NodeJS.Timeout[] = [];
  
  // CPU 使用率计算（基于时间差）
  private lastCpuSample?: { usage: NodeJS.CpuUsage; time: number };
  
  constructor() {
    super();
    
    this.apiMetrics = {
      requestCount: new Map(),
      responseTime: new Map(),
      errorCount: new Map()
    };
    
    this.llmMetrics = {
      callCount: 0,
      totalTokens: 0,
      averageLatency: 0,
      successRate: 1.0,
      costEstimate: 0,
      cacheHitTokens: 0,
      cacheTotalPromptTokens: 0
    };
    
    this.memoryMetrics = {
      retrievalCount: 0,
      averageRetrievalTime: 0,
      cacheHitRate: 0,
      memoryLayerUsage: new Map()
    };
    
    this.executionMetrics = {
      taskCount: 0,
      successCount: 0,
      failureCount: 0,
      averageExecutionTime: 0,
      retryCount: 0
    };
    
    // 启动定期收集
    this.startCollection();
    
    // 初始化事件循环延迟监测（分辨率 20ms）
    this.eventLoopHistogram = monitorEventLoopDelay({ resolution: 20 });
    this.eventLoopHistogram.enable();
  }
  
  /**
   * 注册活跃连接数提供者（由 WebSocket 服务器调用）
   */
  registerConnectionProvider(provider: () => number): void {
    this.connectionCountProvider = provider;
    logger.info('Connection count provider registered');
  }
  
  /**
   * 记录 API 请求
   */
  recordAPIRequest(endpoint: string, durationMs: number, success: boolean): void {
    // 更新请求计数
    const currentCount = this.apiMetrics.requestCount.get(endpoint) || 0;
    this.apiMetrics.requestCount.set(endpoint, currentCount + 1);
    
    // 更新响应时间
    if (!this.apiMetrics.responseTime.has(endpoint)) {
      this.apiMetrics.responseTime.set(endpoint, []);
    }
    const times = this.apiMetrics.responseTime.get(endpoint)!;
    times.push(durationMs);
    if (times.length > this.MAX_DATA_POINTS) {
      times.shift();
    }
    
    // 更新错误计数
    if (!success) {
      const errors = this.apiMetrics.errorCount.get(endpoint) || 0;
      this.apiMetrics.errorCount.set(endpoint, errors + 1);
    }
    
    // 存储数据点
    this.addDataPoint(`api.${endpoint}.latency`, durationMs);
    
    logger.debug('API request recorded', { endpoint, durationMs, success });
  }
  
  /**
   * 记录 LLM 调用
   */
  recordLLMCall(tokens: number, latencyMs: number, success: boolean): void {
    this.llmMetrics.callCount++;
    this.llmMetrics.totalTokens += tokens;
    
    // 更新平均延迟
    const totalCalls = this.llmMetrics.callCount;
    this.llmMetrics.averageLatency = 
      (this.llmMetrics.averageLatency * (totalCalls - 1) + latencyMs) / totalCalls;
    
    // 更新成功率 (简单移动平均)
    const targetSuccessRate = success ? 1.0 : 0.0;
    this.llmMetrics.successRate = 
      (this.llmMetrics.successRate * (totalCalls - 1) + targetSuccessRate) / totalCalls;
    
    // 成本粗略占位估算：按 $0.004/1K tokens 的历史均价折算。
    // 注意：主力模型现已走 Ark Agent Plan 订阅（AFP 积分制），此数字
    // 并非真实成本，仅用于量级参考（2026-08-28 标注）
    this.llmMetrics.costEstimate += (tokens * 0.004) / 1000;
    
    // 存储数据点
    this.addDataPoint('llm.tokens', tokens);
    this.addDataPoint('llm.latency', latencyMs);
    
    logger.debug('LLM call recorded', { tokens, latencyMs, success });
  }
  
  /**
   * 记录 LLM 缓存命中情况（Qwen prompt_tokens_details.cached_tokens）
   */
  recordLLMCache(cachedTokens: number, promptTokens: number): void {
    if (!this.llmMetrics) return;
    // 累积缓存统计
    this.llmMetrics.cacheHitTokens += cachedTokens;
    this.llmMetrics.cacheTotalPromptTokens += promptTokens;
    
    const hitPct = promptTokens > 0 ? Math.round((cachedTokens / promptTokens) * 100) : 0;
    this.addDataPoint('llm.cache_hit_pct', hitPct);
    
    logger.debug('LLM cache recorded', { cachedTokens, promptTokens, hitPct });
  }
  
  /**
   * 记录记忆检索
   */
  recordMemoryRetrieval(durationMs: number, layer: string, cacheHit: boolean): void {
    this.memoryMetrics.retrievalCount++;
    
    // 更新平均检索时间
    const totalCount = this.memoryMetrics.retrievalCount;
    this.memoryMetrics.averageRetrievalTime = 
      (this.memoryMetrics.averageRetrievalTime * (totalCount - 1) + durationMs) / totalCount;
    
    // 更新缓存命中率
    const hits = this.memoryMetrics.cacheHitRate * (totalCount - 1) + (cacheHit ? 1 : 0);
    this.memoryMetrics.cacheHitRate = hits / totalCount;
    
    // 更新各层记忆使用
    const layerCount = this.memoryMetrics.memoryLayerUsage.get(layer) || 0;
    this.memoryMetrics.memoryLayerUsage.set(layer, layerCount + 1);
    
    // 存储数据点
    this.addDataPoint(`memory.${layer}.latency`, durationMs);
    
    logger.debug('Memory retrieval recorded', { durationMs, layer, cacheHit });
  }
  
  /**
   * 记录任务执行
   */
  recordTaskExecution(success: boolean, durationMs: number, retried: boolean): void {
    this.executionMetrics.taskCount++;
    
    if (success) {
      this.executionMetrics.successCount++;
    } else {
      this.executionMetrics.failureCount++;
    }
    
    if (retried) {
      this.executionMetrics.retryCount++;
    }
    
    // 更新平均执行时间
    const totalCount = this.executionMetrics.taskCount;
    this.executionMetrics.averageExecutionTime = 
      (this.executionMetrics.averageExecutionTime * (totalCount - 1) + durationMs) / totalCount;
    
    // 存储数据点
    this.addDataPoint('execution.latency', durationMs);
    this.addDataPoint('execution.success', success ? 1 : 0);
    
    logger.debug('Task execution recorded', { success, durationMs, retried });
  }
  
  /**
   * 获取系统指标
   */
  getSystemMetrics(): SystemMetrics {
    const memUsage = process.memoryUsage();
    const cpuUsage = process.cpuUsage();
    const now = Date.now();
    
    // 计算 CPU 使用率百分比（基于上次采样的时间差）
    let cpuPercent = 0;
    if (this.lastCpuSample) {
      const elapsedMs = now - this.lastCpuSample.time;
      if (elapsedMs > 0) {
        const userDelta = cpuUsage.user - this.lastCpuSample.usage.user;
        const systemDelta = cpuUsage.system - this.lastCpuSample.usage.system;
        // cpuUsage 单位是微秒，elapsedMs 是毫秒
        cpuPercent = ((userDelta + systemDelta) / 1000) / elapsedMs * 100;
      }
    }
    this.lastCpuSample = { usage: cpuUsage, time: now };
    
    return {
      memoryUsage: {
        heapUsed: memUsage.heapUsed / (1024 * 1024),  // MB
        heapTotal: memUsage.heapTotal / (1024 * 1024), // MB
        rss: memUsage.rss / (1024 * 1024)              // MB
      },
      cpuUsage: cpuPercent, // 百分比
      eventLoopDelay: this.calculateEventLoopDelay(),
      activeConnections: this.connectionCountProvider ? this.connectionCountProvider() : 0
    };
  }
  
  /**
   * 获取所有指标摘要
   */
  getSummary(): Record<string, any> {
    const systemMetrics = this.getSystemMetrics();
    
    return {
      timestamp: Date.now(),
      api: {
        totalRequests: Array.from(this.apiMetrics.requestCount.values()).reduce((a, b) => a + b, 0),
        averageResponseTime: this.calculateAverageResponseTime(),
        errorRate: this.calculateErrorRate()
      },
      llm: { ...this.llmMetrics },
      memory: { ...this.memoryMetrics },
      execution: {
        ...this.executionMetrics,
        successRate: this.executionMetrics.taskCount > 0 
          ? this.executionMetrics.successCount / this.executionMetrics.taskCount 
          : 0
      },
      system: systemMetrics
    };
  }
  
  /**
   * 重置指标
   */
  reset(): void {
    this.apiMetrics.requestCount.clear();
    this.apiMetrics.responseTime.clear();
    this.apiMetrics.errorCount.clear();
    
    this.llmMetrics = {
      callCount: 0,
      totalTokens: 0,
      averageLatency: 0,
      successRate: 1.0,
      costEstimate: 0,
      cacheHitTokens: 0,
      cacheTotalPromptTokens: 0
    };
    
    this.memoryMetrics = {
      retrievalCount: 0,
      averageRetrievalTime: 0,
      cacheHitRate: 0,
      memoryLayerUsage: new Map()
    };
    
    this.executionMetrics = {
      taskCount: 0,
      successCount: 0,
      failureCount: 0,
      averageExecutionTime: 0,
      retryCount: 0
    };
    
    this.dataPoints.clear();
    
    logger.info('Metrics reset');
  }
  
  /**
   * 添加数据点
   */
  private addDataPoint(metric: string, value: number, labels?: Record<string, string>): void {
    if (!this.dataPoints.has(metric)) {
      this.dataPoints.set(metric, []);
    }
    
    const points = this.dataPoints.get(metric)!;
    points.push({
      timestamp: Date.now(),
      value,
      labels
    });
    
    if (points.length > this.MAX_DATA_POINTS) {
      points.shift();
    }
  }
  
  /**
   * 计算平均响应时间
   */
  private calculateAverageResponseTime(): number {
    let totalTime = 0;
    let totalCount = 0;
    
    for (const times of this.apiMetrics.responseTime.values()) {
      totalTime += times.reduce((a, b) => a + b, 0);
      totalCount += times.length;
    }
    
    return totalCount > 0 ? totalTime / totalCount : 0;
  }
  
  /**
   * 计算错误率
   */
  private calculateErrorRate(): number {
    let totalErrors = 0;
    let totalRequests = 0;
    
    for (const [endpoint, errors] of this.apiMetrics.errorCount.entries()) {
      const requests = this.apiMetrics.requestCount.get(endpoint) || 0;
      totalErrors += errors;
      totalRequests += requests;
    }
    
    return totalRequests > 0 ? totalErrors / totalRequests : 0;
  }
  
  /**
   * 计算事件循环延迟（返回毫秒）
   */
  private calculateEventLoopDelay(): number {
    const meanNs = this.eventLoopHistogram.mean;
    this.eventLoopHistogram.reset();
    return meanNs / 1e6; // 纳秒转毫秒
  }
  
  /**
   * 启动定期收集
   */
  private startCollection(): void {
    // 每 30 秒记录一次系统指标
    const metricsTimer = setInterval(() => {
      const systemMetrics = this.getSystemMetrics();
      this.emit('system-metrics', systemMetrics);
      
      logger.debug('System metrics collected', systemMetrics);
    }, 30000);
    metricsTimer.unref();
    this.timers.push(metricsTimer);
    
    // 每分钟输出一次摘要
    const summaryTimer = setInterval(() => {
      const summary = this.getSummary();
      logger.info('📊 Metrics Summary', {
        apiRequests: summary.api.totalRequests,
        avgResponseTime: summary.api.averageResponseTime.toFixed(2) + 'ms',
        llmCalls: summary.llm.callCount,
        taskSuccessRate: (summary.execution.successRate * 100).toFixed(1) + '%'
      });
    }, 60000);
    summaryTimer.unref();
    this.timers.push(summaryTimer);
  }
  
  /**
   * 销毁收集器，清理所有定时器
   */
  destroy(): void {
    for (const timer of this.timers) {
      clearInterval(timer);
    }
    this.timers = [];
    this.eventLoopHistogram?.disable();
    logger.info('MetricsCollector destroyed');
  }
}

// ============================================
// 告警系统
// ============================================

export class AlertManager extends EventEmitter {
  private alerts: AlertConfig[] = [];
  private triggeredAlerts: Map<string, AlertEvent> = new Map();
  private readonly COOLDOWN_MS = 300000; // 5 分钟冷却时间
  private monitorTimer?: NodeJS.Timeout;
  
  constructor(private metricsCollector: MetricsCollector) {
    super();
    this.setupDefaultAlerts();
    this.startMonitoring();
  }
  
  /**
   * 添加告警规则
   */
  addAlert(config: AlertConfig): void {
    this.alerts.push(config);
    logger.info('Alert rule added', config);
  }
  
  /**
   * 移除告警规则
   */
  removeAlert(metric: string): void {
    this.alerts = this.alerts.filter(a => a.metric !== metric);
    logger.info('Alert rule removed', { metric });
  }
  
  /**
   * 获取已触发的告警
   */
  getTriggeredAlerts(): AlertEvent[] {
    return Array.from(this.triggeredAlerts.values());
  }
  
  /**
   * 清除告警
   */
  clearAlert(metric: string): void {
    this.triggeredAlerts.delete(metric);
    logger.info('Alert cleared', { metric });
  }
  
  /**
   * 设置默认告警规则
   */
  private setupDefaultAlerts(): void {
    // API 响应时间过长
    // Fix: key was 'api.avgResponseTime' but summary outputs 'api.averageResponseTime'
    this.addAlert({
      metric: 'api.averageResponseTime',
      threshold: 5000, // 5 秒
      operator: '>',
      windowMs: 60000,
      severity: 'warning',
      message: 'API response time exceeds 5 seconds'
    });
    
    // LLM 成功率过低
    this.addAlert({
      metric: 'llm.successRate',
      threshold: 0.8, // 80%
      operator: '<',
      windowMs: 300000,
      severity: 'error',
      message: 'LLM success rate below 80%'
    });
    
    // 内存使用过高
    this.addAlert({
      metric: 'system.memory.heapUsed',
      threshold: 800, // 800MB
      operator: '>',
      windowMs: 60000,
      severity: 'warning',
      message: 'Memory usage exceeds 800MB'
    });
    
    // 任务失败率过高
    // Fix: summary outputs 'execution.successRate' not 'execution.failureRate'.
    // Alert when success rate drops below 80% (equivalent to >20% failure).
    this.addAlert({
      metric: 'execution.successRate',
      threshold: 0.8,
      operator: '<',
      windowMs: 300000,
      severity: 'critical',
      message: 'Task failure rate exceeds 20% (success rate below 80%)'
    });
  }
  
  /**
   * 开始监控
   */
  private startMonitoring(): void {
    this.monitorTimer = setInterval(() => {
      this.checkAlerts();
    }, 10000); // 每 10 秒检查一次
    this.monitorTimer.unref();
  }
  
  /**
   * 停止监控
   */
  destroy(): void {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = undefined;
    }
  }
  
  /**
   * 检查告警
   */
  private checkAlerts(): void {
    const summary = this.metricsCollector.getSummary();
    const now = Date.now();
    
    for (const alert of this.alerts) {
      const currentValue = this.getMetricValue(summary, alert.metric);
      
      if (currentValue === null) {
        continue;
      }
      
      // 检查是否触发告警
      const triggered = this.evaluateCondition(currentValue, alert.threshold, alert.operator);
      
      if (triggered) {
        // 检查冷却时间
        const lastTriggered = this.triggeredAlerts.get(alert.metric);
        if (lastTriggered && (now - lastTriggered.timestamp) < this.COOLDOWN_MS) {
          continue;
        }
        
        // 触发告警
        const event: AlertEvent = {
          timestamp: now,
          metric: alert.metric,
          currentValue,
          threshold: alert.threshold,
          severity: alert.severity,
          message: alert.message
        };
        
        this.triggeredAlerts.set(alert.metric, event);
        this.emit('alert', event);
        
        logger.warn(`🚨 ALERT [${alert.severity.toUpperCase()}]`, {
          metric: alert.metric,
          currentValue,
          threshold: alert.threshold,
          message: alert.message
        });
      }
    }
  }
  
  /**
   * 获取指标值
   */
  private getMetricValue(summary: any, metric: string): number | null {
    const parts = metric.split('.');
    let value: any = summary;
    
    for (const part of parts) {
      if (value === undefined || value === null) {
        return null;
      }
      value = value[part];
    }
    
    return typeof value === 'number' ? value : null;
  }
  
  /**
   * 评估条件
   */
  private evaluateCondition(value: number, threshold: number, operator: string): boolean {
    switch (operator) {
      case '>': return value > threshold;
      case '<': return value < threshold;
      case '>=': return value >= threshold;
      case '<=': return value <= threshold;
      case '==': return value === threshold;
      default: return false;
    }
  }
}

// ============================================
// 单例导出
// ============================================

let metricsCollector: MetricsCollector | null = null;
let alertManager: AlertManager | null = null;

export function getMetricsCollector(): MetricsCollector {
  if (!metricsCollector) {
    metricsCollector = new MetricsCollector();
  }
  return metricsCollector;
}

export function getAlertManager(): AlertManager {
  if (!alertManager) {
    if (!metricsCollector) {
      metricsCollector = new MetricsCollector();
    }
    alertManager = new AlertManager(metricsCollector);
  }
  return alertManager;
}
