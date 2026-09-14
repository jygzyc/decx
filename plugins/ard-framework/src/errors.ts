/**
 * Structured errors for the DECX framework plugin.
 *
 * Port of the former CLI `utils/errors.ts` without the CLI formatter/logger
 * dependencies: an error carries a stable code plus optional details, and the
 * entry point serializes it into the plugin response envelope.
 */
import type { PluginErrorPayload } from "./types";

/** Base error carrying a machine-readable code and optional details. */
export class DecxError extends Error {
  readonly code: string;
  readonly details: Record<string, unknown> | undefined;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "DecxError";
    this.code = code ?? "DECX_ERROR";
    this.details = details;
  }
}

/** File system or external file-tool failure. */
export class FileError extends DecxError {
  constructor(message: string, filePath?: string) {
    super(message, "FILE_ERROR", filePath ? { filePath } : undefined);
    this.name = "FileError";
  }
}

/** Child-process failure (adb, unzip, debugfs, …). */
export class ProcessError extends DecxError {
  constructor(message: string, pid?: number) {
    super(message, "PROCESS_ERROR", pid === undefined ? undefined : { pid });
    this.name = "ProcessError";
  }
}

/** Invalid plugin invocation (bad protocol/command/flags). */
export class RequestError extends DecxError {
  constructor(message: string) {
    super(message, "INVALID_REQUEST");
    this.name = "RequestError";
  }
}

/** A required external tool is not available. */
export class ToolError extends DecxError {
  constructor(message: string, code = "TOOL_NOT_FOUND") {
    super(message, code);
    this.name = "ToolError";
  }
}

/** Convert any thrown value into the response error payload. */
export function errorPayload(error: unknown): PluginErrorPayload {
  if (error instanceof DecxError) {
    return {
      code: error.code,
      message: error.message,
      ...(error.details && Object.keys(error.details).length > 0
        ? { details: error.details }
        : {}),
    };
  }
  if (error instanceof Error) {
    // Unexpected failures keep their stack available for debugging; the CLI
    // prints it when the plugin is invoked with DECX_PLUGIN_DEBUG=1.
    const stack = process.env.DECX_PLUGIN_DEBUG === "1" ? error.stack : undefined;
    return { code: "INTERNAL_ERROR", message: error.message, ...(stack ? { details: { stack } } : {}) };
  }
  return { code: "INTERNAL_ERROR", message: String(error) };
}

module.exports = { DecxError, FileError, ProcessError, RequestError, ToolError, errorPayload };
