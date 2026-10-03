/**
 * 基础设施层 - 错误处理
 * 
 * 参考 OpenClaw: src/infra/errors.ts, src/logging.ts
 * 
 * 设计原则：
 * 1. 所有错误继承自基础错误类
 * 2. 包含错误码、上下文信息
 * 3. 支持错误链 (cause)
 * 4. 可序列化为 JSON
 */

// ============================================
// 基础错误类
// ============================================

export class BaseError extends Error {
  public readonly code: string;
  public readonly details?: Record<string, any>;
  public readonly cause?: Error;
  public readonly timestamp: string;

  constructor(
    message: string,
    options: {
      code: string;
      details?: Record<string, any>;
      cause?: Error;
    }
  ) {
    super(message);
    this.name = this.constructor.name;
    this.code = options.code;
    this.details = options.details;
    this.cause = options.cause;
    this.timestamp = new Date().toISOString();

    // 保持正确的原型链
    Object.setPrototypeOf(this, new.target.prototype);

    // 捕获堆栈跟踪
    if (Error.captureStackTrace) {
      Error.captureStackTrace(this, this.constructor);
    }
  }

  /**
   * 序列化为 JSON (用于日志和 API 响应)
   */
  toJSON(): Record<string, any> {
    return {
      name: this.name,
      code: this.code,
      message: this.message,
      details: this.details,
      cause: this.cause?.message,
      stack: this.stack,
      timestamp: this.timestamp
    };
  }

  /**
   * 附加上下文信息
   */
  withContext(context: Record<string, any>): this {
    (this as any).details = {
      ...this.details,
      ...context
    };
    return this;
  }
}

// ============================================
// 配置错误
// ============================================

export class ConfigurationError extends BaseError {
  constructor(
    message: string,
    options: {
      key?: string;
      expected?: string;
      actual?: unknown;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: 'CONFIG_ERROR',
      details: {
        key: options.key,
        expected: options.expected,
        actual: options.actual
      },
      cause: options.cause
    });
    this.name = 'ConfigurationError';
  }
}

// ============================================
// 工具/Skill 执行错误
// ============================================

export class ToolExecutionError extends BaseError {
  constructor(
    toolName: string,
    message: string,
    options: {
      params?: any;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: 'TOOL_EXECUTION_ERROR',
      details: {
        toolName,
        params: options.params
      },
      cause: options.cause
    });
    this.name = 'ToolExecutionError';
  }
}

export class SkillExecutionError extends BaseError {
  constructor(
    skillName: string,
    message: string,
    options: {
      params?: Record<string, unknown>;
      context?: Record<string, unknown>;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: 'SKILL_EXECUTION_ERROR',
      details: {
        skillName,
        params: options.params,
        context: options.context
      },
      cause: options.cause
    });
    this.name = 'SkillExecutionError';
  }
}

// ============================================
// 文件系统错误
// ============================================

export class FileSystemError extends BaseError {
  constructor(
    operation: string,
    path: string,
    message: string,
    options: {
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: 'FILE_SYSTEM_ERROR',
      details: {
        operation,
        path
      },
      cause: options.cause
    });
    this.name = 'FileSystemError';
  }
}

// ============================================
// 网络错误
// ============================================

export class NetworkError extends BaseError {
  constructor(
    url: string,
    message: string,
    options: {
      method?: string;
      statusCode?: number;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: 'NETWORK_ERROR',
      details: {
        url,
        method: options.method,
        statusCode: options.statusCode
      },
      cause: options.cause
    });
    this.name = 'NetworkError';
  }
}

// ============================================
// LLM API 错误
// ============================================

export class LLMError extends BaseError {
  constructor(
    message: string,
    options: {
      model?: string;
      provider?: string;
      statusCode?: number;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: 'LLM_ERROR',
      details: {
        model: options.model,
        provider: options.provider,
        statusCode: options.statusCode
      },
      cause: options.cause
    });
    this.name = 'LLMError';
  }
}

// ============================================
// 记忆系统错误
// ============================================

export class MemoryError extends BaseError {
  constructor(
    operation: string,
    message: string,
    options: {
      memoryId?: string;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: 'MEMORY_ERROR',
      details: {
        operation,
        memoryId: options.memoryId
      },
      cause: options.cause
    });
    this.name = 'MemoryError';
  }
}

// ============================================
// 验证错误
// ============================================

export class ValidationError extends BaseError {
  constructor(
    message: string,
    options: {
      field?: string;
      value?: any;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: 'VALIDATION_ERROR',
      details: {
        field: options.field,
        value: options.value
      },
      cause: options.cause
    });
    this.name = 'ValidationError';
  }
}

// ============================================
// 路由错误
// ============================================

export class RouterError extends BaseError {
  constructor(
    message: string,
    options: {
      intent?: string;
      query?: string;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: 'ROUTER_ERROR',
      details: {
        intent: options.intent,
        query: options.query
      },
      cause: options.cause
    });
    this.name = 'RouterError';
  }
}

// ============================================
// Agent 错误
// ============================================

export class AgentError extends BaseError {
  constructor(
    agentId: string,
    message: string,
    options: {
      task?: string;
      cause?: Error;
    } = {}
  ) {
    super(message, {
      code: 'AGENT_ERROR',
      details: {
        agentId,
        task: options.task
      },
      cause: options.cause
    });
    this.name = 'AgentError';
  }
}

// ============================================
// 工具函数
// ============================================

/**
 * 安全地包装异步函数，捕获错误并转换为 BaseError
 */
export async function safeExecute<T>(
  fn: () => Promise<T>,
  options: {
    errorCode: string;
    errorMessage: string;
    context?: Record<string, any>;
  }
): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof BaseError) {
      throw error;
    }
    
    const baseError = new BaseError(options.errorMessage, {
      code: options.errorCode,
      details: options.context,
      cause: error as Error
    });
    
    throw baseError;
  }
}

/**
 * 判断错误类型
 */
export function isBaseError(error: unknown): error is BaseError {
  return error instanceof BaseError;
}

export function isConfigurationError(error: unknown): error is ConfigurationError {
  return error instanceof ConfigurationError;
}

export function isToolExecutionError(error: unknown): error is ToolExecutionError {
  return error instanceof ToolExecutionError;
}

export function isSkillExecutionError(error: unknown): error is SkillExecutionError {
  return error instanceof SkillExecutionError;
}

export function isNetworkError(error: unknown): error is NetworkError {
  return error instanceof NetworkError;
}

export function isLLMError(error: unknown): error is LLMError {
  return error instanceof LLMError;
}

/**
 * 从 unknown 类型的 catch 变量中安全提取错误消息
 */
export function getErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
