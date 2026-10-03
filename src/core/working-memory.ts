/**
 * Working Memory / Scratchpad
 * 
 * 跨迭代持久化中间结果的结构化状态存储
 * 参考: LangGraph State, Claude Code TodoWrite, AutoGPT workspace memory
 * 
 * 功能：
 * 1. 跟踪多步任务的中间结果
 * 2. 记录已验证的假设和发现
 * 3. 维护当前执行进度
 * 4. 为 LLM 提供结构化的上下文摘要
 */

import { createModuleLogger } from '../infra/logger.js';

const logger = createModuleLogger('working-memory');

// ============================================
// 类型定义
// ============================================

export interface ScratchpadEntry {
  id: string;
  type: 'finding' | 'hypothesis' | 'result' | 'error' | 'decision' | 'todo';
  content: string;
  source?: string;          // 来源（工具名/阶段）
  confidence?: number;      // 0-1 置信度
  verified?: boolean;       // 是否已验证
  timestamp: number;
  /** todo 状态机（其他类型 entry 忽略此字段） */
  todoStatus?: 'pending' | 'in_progress' | 'completed';
  metadata?: Record<string, unknown>;
}

export interface TaskProgress {
  totalSteps: number;
  completedSteps: number;
  currentStep?: string;
  blockedBy?: string;
}

export interface ScratchpadSnapshot {
  entries: ScratchpadEntry[];
  progress: TaskProgress;
  keyFindings: string[];
  openQuestions: string[];
  summary: string;
}

// ============================================
// Scratchpad 实现
// ============================================

export class Scratchpad {
  private entries: ScratchpadEntry[] = [];
  private progress: TaskProgress;
  private entryCounter = 0;
  private readonly MAX_ENTRIES = 100;

  constructor(totalSteps: number = 0) {
    this.progress = {
      totalSteps,
      completedSteps: 0,
    };
  }

  /**
   * 添加一个发现/结果
   */
  addFinding(content: string, source?: string, confidence: number = 0.8): string {
    return this.addEntry('finding', content, source, confidence);
  }

  /**
   * 添加一个假设
   */
  addHypothesis(content: string, source?: string): string {
    return this.addEntry('hypothesis', content, source, 0.5);
  }

  /**
   * 记录工具执行结果
   */
  addResult(content: string, toolName: string, success: boolean): string {
    const id = this.addEntry('result', content, toolName, success ? 0.9 : 0.3);
    if (success && this.progress.totalSteps > 0) {
      // 不超过总步骤数，避免进度百分比 > 100%
      this.progress.completedSteps = Math.min(
        this.progress.completedSteps + 1,
        this.progress.totalSteps
      );
    } else if (success) {
      this.progress.completedSteps++;
    }
    return id;
  }

  /**
   * 记录错误
   */
  addError(content: string, source?: string): string {
    return this.addEntry('error', content, source, 1.0);
  }

  /**
   * 记录决策
   */
  addDecision(content: string, reason?: string): string {
    return this.addEntry('decision', reason ? `${content} (because: ${reason})` : content, 'agent', 0.9);
  }

  /**
   * 添加待办项
   */
  addTodo(content: string): string {
    const id = this.addEntry('todo', content, 'agent', 1.0);
    const entry = this.entries.find(e => e.id === id);
    if (entry) entry.todoStatus = 'pending';
    return id;
  }

  /**
   * 更新 todo 状态（LLM 通过 todo.write 工具调用）
   * @param updates 按内容前缀或 id 匹配 todo 条目
   */
  updateTodoStatus(match: { id?: string; contentPrefix?: string }, status: 'pending' | 'in_progress' | 'completed'): boolean {
    const todo = this.entries.find(e => {
      if (e.type !== 'todo') return false;
      if (match.id) return e.id === match.id;
      if (match.contentPrefix) return e.content.toLowerCase().startsWith(match.contentPrefix.toLowerCase());
      return false;
    });
    if (!todo) return false;
    todo.todoStatus = status;
    // 完成时提升置信度（供 formatForContext 的 findings 阈值过滤）
    if (status === 'completed') {
      todo.confidence = 0.95;
      this.progress.completedSteps = Math.min(this.progress.completedSteps + 1, Math.max(this.progress.totalSteps, 1));
    }
    if (status === 'in_progress') {
      this.progress.currentStep = todo.content.slice(0, 80);
    }
    logger.debug('Todo status updated', { id: todo.id, status });
    return true;
  }

  /**
   * 获取 todo 列表（含状态）
   */
  getTodoList(): Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }> {
    return this.entries
      .filter(e => e.type === 'todo')
      .map(e => ({ id: e.id, content: e.content, status: e.todoStatus || 'pending' }));
  }

  /**
   * 清空所有 todo 条目（todo.write 整体替换语义）
   */
  clearTodos(): void {
    const todoCount = this.entries.filter(e => e.type === 'todo').length;
    this.entries = this.entries.filter(e => e.type !== 'todo');
    // 重置进度到剩余工作量的合理基线
    if (todoCount > 0) {
      this.progress.completedSteps = 0;
    }
  }

  /**
   * 生成 todo 清单文本（注入上下文用，仿 Claude Code TodoWrite 显示格式）
   */
  formatTodoList(): string {
    const todos = this.getTodoList();
    if (todos.length === 0) return '';
    const lines = todos.map(t => {
      const icon = t.status === 'completed' ? '✅' : t.status === 'in_progress' ? '🔄' : '⬜';
      return `${icon} ${t.content}`;
    });
    const done = todos.filter(t => t.status === 'completed').length;
    return `Todos (${done}/${todos.length}):\n${lines.join('\n')}`;
  }

  /**
   * 验证一个假设
   */
  verifyHypothesis(entryId: string, verified: boolean): void {
    const entry = this.entries.find(e => e.id === entryId);
    if (entry && entry.type === 'hypothesis') {
      entry.verified = verified;
      entry.confidence = verified ? 0.95 : 0.1;
      if (verified) {
        entry.type = 'finding'; // Promote to finding
      }
    }
  }

  /**
   * 更新进度
   */
  updateProgress(currentStep?: string, blockedBy?: string): void {
    if (currentStep !== undefined) this.progress.currentStep = currentStep;
    if (blockedBy !== undefined) this.progress.blockedBy = blockedBy;
  }

  /**
   * 设置总步骤数
   */
  setTotalSteps(total: number): void {
    this.progress.totalSteps = total;
  }

  /**
   * 获取关键发现
   */
  getKeyFindings(): string[] {
    return this.entries
      .filter(e => e.type === 'finding' && (e.confidence || 0) >= 0.7)
      .sort((a, b) => (b.confidence || 0) - (a.confidence || 0))
      .slice(0, 10)
      .map(e => e.content);
  }

  /**
   * 获取未解决的问题
   */
  getOpenQuestions(): string[] {
    return this.entries
      .filter(e => e.type === 'hypothesis' && !e.verified)
      .map(e => e.content);
  }

  /**
   * 获取错误列表
   */
  getErrors(): string[] {
    return this.entries
      .filter(e => e.type === 'error')
      .map(e => e.content);
  }

  /**
   * 生成结构化快照（用于注入 LLM 上下文）
   */
  getSnapshot(): ScratchpadSnapshot {
    return {
      entries: [...this.entries],
      progress: { ...this.progress },
      keyFindings: this.getKeyFindings(),
      openQuestions: this.getOpenQuestions(),
      summary: this.generateSummary(),
    };
  }

  /**
   * 格式化为 LLM 可读的上下文段落
   */
  formatForContext(): string {
    if (this.entries.length === 0) return '';

    const sections: string[] = ['\n\n## Working Memory (Scratchpad)'];

    // Todo list (LLM must see pending work every round)
    const todoList = this.formatTodoList();
    if (todoList) {
      sections.push('\n### Todos');
      sections.push(todoList);
    }

    // Progress
    if (this.progress.totalSteps > 0) {
      const pct = Math.round((this.progress.completedSteps / this.progress.totalSteps) * 100);
      sections.push(`Progress: ${this.progress.completedSteps}/${this.progress.totalSteps} steps (${pct}%)`);
      if (this.progress.currentStep) {
        sections.push(`Current: ${this.progress.currentStep}`);
      }
      if (this.progress.blockedBy) {
        sections.push(`⚠️ Blocked by: ${this.progress.blockedBy}`);
      }
    }

    // Key findings
    const findings = this.getKeyFindings();
    if (findings.length > 0) {
      sections.push('\n### Key Findings');
      findings.forEach(f => sections.push(`- ✅ ${f}`));
    }

    // Open questions
    const questions = this.getOpenQuestions();
    if (questions.length > 0) {
      sections.push('\n### Open Questions');
      questions.forEach(q => sections.push(`- ❓ ${q}`));
    }

    // Recent errors
    const errors = this.getErrors().slice(-3);
    if (errors.length > 0) {
      sections.push('\n### Recent Errors');
      errors.forEach(e => sections.push(`- ❌ ${e}`));
    }

    // Decisions
    const decisions = this.entries.filter(e => e.type === 'decision').slice(-3);
    if (decisions.length > 0) {
      sections.push('\n### Decisions Made');
      decisions.forEach(d => sections.push(`- 🔹 ${d.content}`));
    }

    return sections.join('\n');
  }

  /**
   * 生成摘要
   */
  private generateSummary(): string {
    const findings = this.getKeyFindings().length;
    const errors = this.getErrors().length;
    const open = this.getOpenQuestions().length;
    const pct = this.progress.totalSteps > 0
      ? Math.round((this.progress.completedSteps / this.progress.totalSteps) * 100)
      : 0;

    return `${pct}% complete. ${findings} findings, ${errors} errors, ${open} open questions.`;
  }

  /**
   * 内部：添加条目
   */
  private addEntry(type: ScratchpadEntry['type'], content: string, source?: string, confidence?: number): string {
    const id = `sp_${++this.entryCounter}`;
    const entry: ScratchpadEntry = {
      id,
      type,
      content: content.slice(0, 500), // Limit content length
      source,
      confidence,
      verified: false,
      timestamp: Date.now(),
    };

    this.entries.push(entry);

    // Evict oldest low-value entries if over limit
    if (this.entries.length > this.MAX_ENTRIES) {
      // Remove oldest non-finding entries first; todos are durable (plan items)
      const idx = this.entries.findIndex(e =>
        e.type !== 'finding' && e.type !== 'decision' && e.type !== 'todo');
      if (idx >= 0) {
        this.entries.splice(idx, 1);
      } else {
        this.entries.shift();
      }
    }

    logger.debug('Scratchpad entry added', { id, type, source });
    return id;
  }

  /**
   * 清空
   */
  clear(): void {
    this.entries = [];
    this.progress = { totalSteps: 0, completedSteps: 0 };
    this.entryCounter = 0;
  }

  /**
   * 获取条目数量
   */
  get size(): number {
    return this.entries.length;
  }
}
