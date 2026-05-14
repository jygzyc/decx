/**
 * Error handling utilities for DECX CLI.
 * Provides structured error types and handling helpers.
 */

import { Formatter } from "./formatter.js";
import { logError } from "./logger.js";

/**
 * Base error class for DECX CLI.
 */
export class DecxError extends Error {
  constructor(
    message: string,
    public readonly code?: string,
    public readonly details?: Record<string, unknown>
  ) {
    super(message);
    this.name = "DecxError";
  }

  format(fmt: Formatter): void {
    fmt.error(this.message);
  }
}

/**
 * Process-related errors.
 */
export class ProcessError extends DecxError {
  constructor(message: string, pid?: number) {
    super(message, "PROCESS_ERROR", { pid });
    this.name = "ProcessError";
  }
}

/**
 * Server connection errors.
 */
export class ServerError extends DecxError {
  constructor(message: string, port?: number) {
    super(message, "SERVER_ERROR", { port });
    this.name = "ServerError";
  }
}

/**
 * File operation errors.
 */
export class FileError extends DecxError {
  constructor(message: string, filePath?: string) {
    super(message, "FILE_ERROR", { filePath });
    this.name = "FileError";
  }
}

/**
 * Configuration errors.
 */
export class ConfigError extends DecxError {
  constructor(message: string, key?: string) {
    super(message, "CONFIG_ERROR", { key });
    this.name = "ConfigError";
  }
}

/**
 * Error handler for CLI commands.
 */
export function handleCliError(error: unknown, formatter: Formatter): never {
  if (error instanceof DecxError) {
    error.format(formatter);
    logError({ code: error.code, message: error.message, name: error.name });
  } else if (error instanceof Error) {
    formatter.error(error.message);
    logError({ message: error.message, name: error.name });
    if (process.env.DECX_DEBUG === "1") {
      console.error(error.stack);
    }
  } else {
    formatter.error(String(error));
    logError({ message: String(error) });
  }
  process.exit(1);
}

/**
 * Wrap async command handler with error handling.
 */
export function withErrorHandler<T extends unknown[], R>(
  fn: (...args: T) => Promise<R>,
): (...args: T) => Promise<R | void> {
  return async (...args: T) => {
    try {
      return await fn(...args);
    } catch (error) {
      handleCliError(error, new Formatter());
    }
  };
}

/**
 * Assert condition and throw formatted error if false.
 */
export function assert(
  condition: boolean,
  message: string,
  ErrorClass: typeof DecxError = DecxError
): asserts condition {
  if (!condition) {
    throw new ErrorClass(message);
  }
}
