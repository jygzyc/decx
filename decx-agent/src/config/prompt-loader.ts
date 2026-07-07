/**
 * Prompt loader — assembles a subagent prompt from a PromptSpec.
 *
 * Reads the role preamble from `prompt.file` (required, relative to the task
 * config dir). Appends optional `rules`, `knowledge`, and `instructions`
 * files/text in order. The dynamic graph context is prepended separately by
 * ContextBuilder; this loader only produces the static role preamble.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import type { PromptSpec } from "../agent/types.js";

export interface ResolvedPrompt {
  preamble: string;
  fromConfig: boolean;
}

export interface PromptLoaderOptions {
  baseDir?: string;
}

export class PromptLoader {
  constructor(private readonly options: PromptLoaderOptions = {}) {}

  load(spec: PromptSpec): ResolvedPrompt {
    const parts: string[] = [];

    const primary = this.tryReadFile(spec.file);
    if (!primary) {
      return { preamble: "", fromConfig: false };
    }
    parts.push(primary);

    if (spec.rules) {
      for (const rule of spec.rules) {
        const text = this.tryReadFile(rule) ?? rule;
        if (text) parts.push("---\n" + text);
      }
    }

    if (spec.knowledge) {
      for (const k of spec.knowledge) {
        const text = this.tryReadFile(k) ?? k;
        if (text) parts.push("---\n" + text);
      }
    }

    if (spec.instructions) {
      parts.push("---\nInstructions: " + spec.instructions);
    }

    return { preamble: parts.join("\n\n"), fromConfig: true };
  }

  private tryReadFile(pathOrText: string): string | undefined {
    if (!pathOrText) return undefined;
    if (looksLikePath(pathOrText)) {
      const abs = this.resolvePath(pathOrText);
      if (existsSync(abs)) {
        return readFileSync(abs, "utf-8");
      }
    }
    return undefined;
  }

  private resolvePath(p: string): string {
    return isAbsolute(p) ? p : resolve(this.options.baseDir ?? process.cwd(), p);
  }
}

function looksLikePath(s: string): boolean {
  return /[\\/]/.test(s) || /\.[a-z0-9]+$/i.test(s) || s.startsWith(".") || s.startsWith("~/");
}
