/**
 * 基础设施层 - 日志系统
 * 
 * 参考 OpenClaw: src/logging.ts, src/logger.test.ts, src/logging/subsystem.ts
 * 
 * 功能：
 * 1. 结构化日志输出
 * 2. 日志级别控制
 * 3. 模块标识
 * 4. 支持 JSON 输出 (用于日志收集)
 */

import { EventEmitter } from 'events';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { LogEntry } from './types.js';

// ============================================
// 日志级别
// ============================================

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3
}

const LogLevelNames: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: 'DEBUG',
  [LogLevel.INFO]: 'INFO',
  [LogLevel.WARN]: 'WARN',
  [LogLevel.ERROR]: 'ERROR'
};

const LogLevelValues: Record<string, LogLevel> = {
  debug: LogLevel.DEBUG,
  info: LogLevel.INFO,
  warn: LogLevel.WARN,
  error: LogLevel.ERROR
};

// ============================================
// 日志配置
// ============================================

export interface LoggerOptions {
  module: string;
  level?: LogLevel | string;
  json?: boolean;
  timestamp?: boolean;
  colors?: boolean;
}

// ============================================
// 日志器类
// ============================================

// ============================================
// Rolling log system: date rotation + size rotation + retention cleanup
// ============================================
const LOG_MAX_SIZE = 10 * 1024 * 1024; // 10MB per file before size rotation
const LOG_RETENTION_DAYS = 14;         // keep 14 days of logs
const LOG_MAX_FILES_PER_DAY = 5;       // mindpond-YYYY-MM-DD.log, .1, .2, ... max 5

let _logStream: fs.WriteStream | null = null;
let _logFileDate = '';
let _logFileSize = 0;
let _logFilePath = '';
let _cleanupDone = false;

function getLogDir(): string {
  const logDir = process.env.MINDPOND_LOG_DIR
    ? path.resolve(process.env.MINDPOND_LOG_DIR)
    : path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'logs');
  if (!fs.existsSync(logDir)) fs.mkdirSync(logDir, { recursive: true });
  return logDir;
}

function todayStr(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Rotate by size: mindpond-DATE.log → .1 → .2 ... (oldest dropped) */
function rotateBySize(basePath: string): void {
  try {
    // Delete oldest if at cap
    const oldest = `${basePath}.${LOG_MAX_FILES_PER_DAY - 1}`;
    if (fs.existsSync(oldest)) fs.unlinkSync(oldest);
    // Shift .3→.4, .2→.3, .1→.2
    for (let i = LOG_MAX_FILES_PER_DAY - 2; i >= 1; i--) {
      const src = `${basePath}.${i}`;
      if (fs.existsSync(src)) fs.renameSync(src, `${basePath}.${i + 1}`);
    }
    // Current → .1
    if (fs.existsSync(basePath)) fs.renameSync(basePath, `${basePath}.1`);
  } catch { /* best-effort */ }
}

/** Delete log files older than retention period (run once per process start) */
function cleanupOldLogs(): void {
  if (_cleanupDone) return;
  _cleanupDone = true;
  try {
    const logDir = getLogDir();
    const cutoff = Date.now() - LOG_RETENTION_DAYS * 86400_000;
    for (const f of fs.readdirSync(logDir)) {
      if (!f.startsWith('mindpond-')) continue;
      const fp = path.join(logDir, f);
      try {
        const st = fs.statSync(fp);
        if (st.mtimeMs < cutoff) fs.unlinkSync(fp);
      } catch { /* skip */ }
    }
  } catch { /* best-effort */ }
}

function getLogStream(): fs.WriteStream | null {
  const today = todayStr();

  // Date rotation: new day → close old stream
  if (_logStream && _logFileDate !== today) {
    try { _logStream.end(); } catch { /* */ }
    _logStream = null;
  }

  // Size rotation
  if (_logStream && _logFileSize >= LOG_MAX_SIZE) {
    try { _logStream.end(); } catch { /* */ }
    _logStream = null;
    rotateBySize(_logFilePath);
  }

  if (_logStream) return _logStream;

  try {
    const logDir = getLogDir();
    cleanupOldLogs();
    _logFilePath = path.join(logDir, `mindpond-${today}.log`);
    _logFileDate = today;
    try { _logFileSize = fs.existsSync(_logFilePath) ? fs.statSync(_logFilePath).size : 0; } catch { _logFileSize = 0; }
    _logStream = fs.createWriteStream(_logFilePath, { flags: 'a' });
    _logStream.on('error', () => { _logStream = null; }); // 防止未处理的 error 事件崩溃进程
    return _logStream;
  } catch { return null; }
}

// ============================================
// Context analysis log (dedicated, for self-diagnosis)
// Records per-LLM-request: token breakdown, cache hit, stale compression events
// ============================================
let _ctxStream: fs.WriteStream | null = null;
let _ctxFileDate = '';
let _ctxFileSize = 0;
let _ctxFilePath = '';
const CTX_MAX_SIZE = 5 * 1024 * 1024; // 5MB

function getCtxStream(): fs.WriteStream | null {
  const today = todayStr();
  if (_ctxStream && _ctxFileDate !== today) {
    try { _ctxStream.end(); } catch { /* */ }
    _ctxStream = null;
  }
  if (_ctxStream && _ctxFileSize >= CTX_MAX_SIZE) {
    try { _ctxStream.end(); } catch { /* */ }
    _ctxStream = null;
    rotateBySize(_ctxFilePath);
  }
  if (_ctxStream) return _ctxStream;
  try {
    const logDir = getLogDir();
    _ctxFilePath = path.join(logDir, `context-${today}.log`);
    _ctxFileDate = today;
    try { _ctxFileSize = fs.existsSync(_ctxFilePath) ? fs.statSync(_ctxFilePath).size : 0; } catch { _ctxFileSize = 0; }
    _ctxStream = fs.createWriteStream(_ctxFilePath, { flags: 'a' });
    _ctxStream.on('error', () => { _ctxStream = null; });
    return _ctxStream;
  } catch { return null; }
}

/**
 * Write a structured context-analysis record.
 * Called by orchestrator/llm-client to log token breakdown per request.
 */
export function logContextAnalysis(record: Record<string, unknown>): void {
  try {
    const stream = getCtxStream();
    if (!stream) return;
    const line = JSON.stringify({ ts: new Date().toISOString(), ...record });
    stream.write(line + '\n');
    _ctxFileSize += Buffer.byteLength(line) + 1;
  } catch { /* best-effort */ }
}

export class Logger extends EventEmitter {
  private readonly module: string;
  private readonly level: LogLevel;
  private readonly json: boolean;
  private readonly timestamp: boolean;
  private readonly colors: boolean;

  constructor(options: LoggerOptions) {
    super();
    this.module = options.module;
    this.level = this.parseLogLevel(options.level || LogLevel.INFO);
    this.json = options.json || false;
    this.timestamp = options.timestamp !== false;
    this.colors = options.colors !== false;
  }

  /**
   * 调试日志
   */
  debug(message: string, data?: any): void {
    this.log(LogLevel.DEBUG, message, data);
  }

  /**
   * 信息日志
   */
  info(message: string, data?: any): void {
    this.log(LogLevel.INFO, message, data);
  }

  /**
   * 警告日志
   */
  warn(message: string, data?: any): void {
    this.log(LogLevel.WARN, message, data);
  }

  /**
   * 错误日志
   */
  error(message: string, data?: any): void {
    this.log(LogLevel.ERROR, message, data);
  }

  /**
   * 创建子日志器 (带模块前缀)
   */
  child(module: string): Logger {
    return new Logger({
      module: `${this.module}:${module}`,
      level: this.level,
      json: this.json,
      colors: this.colors
    });
  }

  /**
   * 核心日志方法
   */
  private log(level: LogLevel, message: string, data?: any): void {
    // 检查日志级别
    if (level < this.level) {
      return;
    }

    const entry: LogEntry = {
      timestamp: this.timestamp ? new Date().toISOString() : '',
      level: LogLevelNames[level] as 'debug' | 'info' | 'warn' | 'error',
      module: this.module,
      message,
      data
    };

    // 触发事件 (用于日志收集)
    this.emit('log', entry);

    // 输出到控制台
    if (this.json) {
      this.outputJson(entry);
    } else {
      this.outputText(entry);
    }

    // 写入文件日志
    try {
      const stream = getLogStream();
      if (stream) {
        const line = `${entry.timestamp} ${entry.level.padEnd(5)} [${entry.module}] ${entry.message}` +
          (entry.data ? ' ' + JSON.stringify(entry.data) : '') + '\n';
        stream.write(line);
        _logFileSize += Buffer.byteLength(line);
      }
    } catch { /* file log is best-effort */ }
  }

  /**
   * JSON 格式输出
   */
  private outputJson(entry: LogEntry): void {
    const output = this.timestamp
      ? JSON.stringify(entry)
      : JSON.stringify({
          level: entry.level,
          module: entry.module,
          message: entry.message,
          data: entry.data
        });

    switch (entry.level) {
      case LogLevelNames[LogLevel.ERROR]:
        console.error(output);
        break;
      case LogLevelNames[LogLevel.WARN]:
        console.warn(output);
        break;
      default:
        if (process.env.MINDPOND_LOG_STDERR === '1') console.error(output);
        else console.log(output);
    }
  }

  /**
   * 文本格式输出
   */
  private outputText(entry: LogEntry): void {
    const { timestamp, level, module, message, data } = entry;

    // 构建日志行
    let parts: string[] = [];

    if (this.timestamp && timestamp) {
      parts.push(this.colorize(timestamp, 'gray'));
    }

    parts.push(this.colorize(level, this.getLevelColor(level)));
    parts.push(this.colorize(`[${module}]`, 'cyan'));
    parts.push(message);

    let logLine = parts.join(' ');

    // 附加数据
    if (data !== undefined) {
      if (typeof data === 'string') {
        logLine += ` ${data}`;
      } else {
        logLine += `\n${JSON.stringify(data, null, 2)}`;
      }
    }

    // 输出
    switch (level) {
      case LogLevelNames[LogLevel.ERROR]:
        console.error(logLine);
        break;
      case LogLevelNames[LogLevel.WARN]:
        console.warn(logLine);
        break;
      default:
        if (process.env.MINDPOND_LOG_STDERR === '1') console.error(logLine);
        else console.log(logLine);
    }
  }

  /**
   * 解析日志级别
   */
  private parseLogLevel(level: LogLevel | string): LogLevel {
    if (typeof level === 'number') {
      return level;
    }
    return LogLevelValues[level.toLowerCase()] || LogLevel.INFO;
  }

  /**
   * 获取日志级别颜色
   */
  private getLevelColor(level: string): string {
    switch (level) {
      case 'DEBUG':
        return 'gray';
      case 'INFO':
        return 'green';
      case 'WARN':
        return 'yellow';
      case 'ERROR':
        return 'red';
      default:
        return 'white';
    }
  }

  /**
   * 颜色化文本 (ANSI)
   */
  private colorize(text: string, color: string): string {
    if (!this.colors) {
      return text;
    }

    const colors: Record<string, string> = {
      gray: '\x1b[90m',
      red: '\x1b[31m',
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      cyan: '\x1b[36m',
      white: '\x1b[37m',
      reset: '\x1b[0m'
    };

    const colorCode = colors[color] || colors.white;
    return `${colorCode}${text}${colors.reset}`;
  }
}

// ============================================
// 日志工厂
// ============================================

let defaultLogger: Logger | null = null;

/**
 * 创建日志器
 */
export function createLogger(options: LoggerOptions): Logger {
  return new Logger(options);
}

/**
 * 获取默认日志器
 */
export function getDefaultLogger(): Logger {
  if (!defaultLogger) {
    defaultLogger = new Logger({
      module: 'mindpond',
      level: process.env.LOG_LEVEL || 'info',
      json: process.env.LOG_FORMAT === 'json',
      colors: process.env.NO_COLOR !== '1'
    });
  }
  return defaultLogger;
}

/**
 * 设置默认日志器
 */
export function setDefaultLogger(logger: Logger): void {
  defaultLogger = logger;
}

/**
 * 便捷日志函数 (使用默认日志器)
 */
export const debug = (message: string, data?: any) => getDefaultLogger().debug(message, data);
export const info = (message: string, data?: any) => getDefaultLogger().info(message, data);
export const warn = (message: string, data?: any) => getDefaultLogger().warn(message, data);
export const error = (message: string, data?: any) => getDefaultLogger().error(message, data);

/**
 * 创建模块日志器
 */
export function createModuleLogger(module: string): Logger {
  return getDefaultLogger().child(module);
}

/**
 * Synchronously flush the file log stream.
 * Safe to call from crash handlers (e.g. uncaughtException) before process.exit.
 */
export function flushLogStream(): void {
  try {
    if (_logStream) {
      _logStream.end();
      _logStream = null;
    }
    if (_ctxStream) {
      _ctxStream.end();
      _ctxStream = null;
    }
  } catch { /* best-effort */ }
}

// ============================================
// 日志流捕获 (用于测试)
// ============================================

export interface LogCapture {
  entries: LogEntry[];
  clear: () => void;
  destroy: () => void;
}

/**
 * 捕获日志 (用于测试)
 */
export function captureLogs(logger?: Logger): LogCapture {
  const target = logger || getDefaultLogger();
  const entries: LogEntry[] = [];

  const handler = (entry: LogEntry) => {
    entries.push(entry);
  };

  target.on('log', handler);

  return {
    entries,
    clear: () => {
      entries.length = 0;
    },
    destroy: () => {
      target.off('log', handler);
    }
  };
}
