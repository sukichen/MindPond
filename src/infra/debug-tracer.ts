/**
 * DebugTracer — 全局调试追踪事件总线
 *
 * CLI `/debug` 模式启用后，所有子系统通过 debugTrace() 发射追踪事件。
 * CLI 端订阅 'trace' 事件，渲染单行摘要；长内容存入 buffer，Ctrl+O 查看。
 */

import { EventEmitter } from 'events';

// ============================================
// Types
// ============================================

export interface TraceEntry {
  seq: number;          // 序号（当前请求内递增）
  step: string;         // 步骤标识，如 LLM_CALL, HYBRID_ANN
  icon: string;         // 显示图标
  summary: string;      // 一行摘要
  detail?: string;      // 可选长内容（完整 prompt / response / tool result）
  timestamp: number;
}

// ============================================
// DebugTracer
// ============================================

export class DebugTracer extends EventEmitter {
  private _enabled: boolean = false;
  private _buffer: TraceEntry[] = [];
  private _seq: number = 0;

  get enabled(): boolean {
    return this._enabled;
  }

  set enabled(val: boolean) {
    this._enabled = val;
    if (val) {
      this.emit('enabled');
    } else {
      this.emit('disabled');
    }
  }

  toggle(): boolean {
    this.enabled = !this._enabled;
    return this._enabled;
  }

  /** 开始一次新请求，清空 buffer */
  beginRequest(): void {
    this._buffer = [];
    this._seq = 0;
  }

  /** 结束请求 */
  endRequest(): void {
    this.emit('requestEnd', this._buffer);
  }

  /** 获取当前请求的所有 trace 条目 */
  getBuffer(): TraceEntry[] {
    return this._buffer;
  }

  /** 获取有 detail 的条目（用于 Ctrl+O 列表） */
  getDetailEntries(): TraceEntry[] {
    return this._buffer.filter(e => e.detail);
  }

  /**
   * 发射一条追踪事件
   * @param step  步骤标识 (e.g. 'LLM_CALL')
   * @param icon  显示图标 (e.g. '🤖')
   * @param summary 一行摘要
   * @param detail 可选长文本
   */
  trace(step: string, icon: string, summary: string, detail?: string): void {
    if (!this._enabled) return;

    const entry: TraceEntry = {
      seq: ++this._seq,
      step,
      icon,
      summary,
      detail,
      timestamp: Date.now(),
    };

    this._buffer.push(entry);
    this.emit('trace', entry);
  }
}

// ============================================
// Singleton
// ============================================

let _instance: DebugTracer | null = null;

export function getDebugTracer(): DebugTracer {
  if (!_instance) {
    _instance = new DebugTracer();
  }
  return _instance;
}

/**
 * 便捷函数：发射 trace（tracer 未启用时自动跳过）
 */
export function debugTrace(step: string, icon: string, summary: string, detail?: string): void {
  const tracer = getDebugTracer();
  if (!tracer.enabled) return;
  tracer.trace(step, icon, summary, detail);
}
