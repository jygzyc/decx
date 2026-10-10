export class InstallError extends Error {
  readonly code: string;
  readonly hint: string | undefined;
  readonly exitCode: number;

  constructor(code: string, message: string, options: { hint?: string; exitCode?: number } = {}) {
    super(message);
    this.name = 'InstallError';
    this.code = code;
    this.hint = options.hint;
    this.exitCode = options.exitCode ?? 1;
  }
}
