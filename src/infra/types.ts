/**
 * 基础设施层 - 共享类型定义
 * 
 * 参考 OpenClaw: src/infra/types.ts, src/types/
 */

// ============================================
// 配置类型
// ============================================

export interface LLMConfig {
  apiKey: string;
  model: string;
  baseUrl?: string;
  timeout: number;
  maxRetries: number;
}

export interface MemoryConfig {
  provider: 'fs' | 'sqlite' | 'memory';
  basePath: string;
  maxEntries: number;
  ttl: number;
}

export interface ServerConfig {
  port: number;
  host: string;
  corsOrigins: string[];
  rateLimit?: {
    windowMs: number;
    maxRequests: number;
  };
}

export interface Config {
  llm: LLMConfig;
  memory: MemoryConfig;
  server: ServerConfig;
  workspace: string;
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

// ============================================
// 错误类型
// ============================================

export interface ErrorDetails {
  code: string;
  message: string;
  details?: Record<string, any>;
  cause?: Error;
}

// ============================================
// 工具/Skill 类型
// ============================================

export interface ToolParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'object' | 'array';
  description: string;
  required: boolean;
  default?: any;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  returns: string;
}

export interface ToolResult {
  success: boolean;
  data?: any;
  error?: string;
  message?: string;
}

// ============================================
// 日志类型
// ============================================

export interface LogEntry {
  timestamp: string;
  level: 'debug' | 'info' | 'warn' | 'error';
  module: string;
  message: string;
  data?: any;
}

// ============================================
// 通用工具类型
// ============================================

export type Nullable<T> = T | null;
export type Optional<T> = T | undefined;
export type AsyncFunction<T = void> = () => Promise<T>;

export type Result<T, E = Error> = 
  | { success: true; data: T }
  | { success: false; error: E };
