/** Stable error codes shared by the extension UI, CLI and tests. */

export class WikiError extends Error {
  readonly code: string;
  readonly hint: string | undefined;

  constructor(code: string, message: string, hint?: string) {
    super(message);
    this.name = 'WikiError';
    this.code = code;
    this.hint = hint;
  }
}

export function isWikiError(error: unknown): error is WikiError {
  return error instanceof WikiError;
}
