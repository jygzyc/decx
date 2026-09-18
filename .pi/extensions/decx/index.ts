/**
 * Decx extension.
 *
 * A decx workspace has WikiSkill's three sibling layers (the model lives in
 * `lib.ts`, the rules in AGENTS.md and skills/AGENTS.md):
 *
 *   raw/traces/  immutable execution traces (private by default)
 *   wiki/    index.md, patterns/*.md, logs.md, skill-impact.md — the shared,
 *            never-rolled-back maintenance layer
 *   skills/  <name>/SKILL.md + PURPOSE.md + references — self-contained
 *            execution procedures the inference agent reads on its own
 *
 * The tools here serve maintenance: consult the catalog, record a trace,
 * consolidate patterns, propose at most one atomic skill change, lint the
 * structure. The lint is structural only — it never claims a validation score.
 *
 * Config (optional): `.pi/extensions/decx.json`
 *   {
 *     "workspaces": [{ "name": "decx", "root": "." }],
 *     "checkpoints": { "every": 7, "unit": "round", "inject": true }
 *   }
 * Without it the project itself is the single workspace as soon as it has a
 * `skills/` or `wiki/` layer. A checkpoint is asked for every 7 user rounds
 * (`unit: "turn"` counts agent turns instead, `inject: false` only counts).
 *
 * Checkpoints are session state and live in `<agent dir>/decx/sessions/`, not
 * in the wiki.
 */

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { CONFIG_DIR_NAME, DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, getAgentDir, truncateHead, withFileMutationQueue } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { nodeFs } from './node-fs.ts';
import {
  applyMaintain,
  checkpointBlock,
  checkpointDirective,
  checkpointDue,
  describeCheckpoint,
  describeFinding,
  describeStatus,
  discoverWorkspaces,
  ensureWorkspace,
  isWikiError,
  lastCheckpoint,
  readPage,
  readSessionState,
  recordCheckpoint,
  readWorkspaceConfig,
  recordProposal,
  requireWorkspace,
  resyncIndex,
  skillDirs,
  stateFileName,
  status,
  writeSessionState,
  writeTrace,
  type CheckpointUnit,
  type LintFinding,
  type SessionState,
  type WikiFs,
  type Workspace,
} from './lib.ts';

const WORKSPACE = Type.String({ description: 'Workspace name (a project with raw/, wiki/ and skills/), e.g. "decx"' });

const EDIT = Type.Object({
  op: Type.Union([Type.Literal('append'), Type.Literal('replace'), Type.Literal('insert_after')], {
    description: '"append" (add to the page), "replace" (swap the target substring) or "insert_after" (insert after it)',
  }),
  target: Type.Optional(Type.String({ description: 'Exact substring of the current page; required for replace/insert_after and must occur exactly once' })),
  content: Type.String({ description: 'Markdown to append, insert or replace with' }),
});

const PATCH = Type.Object({
  summary: Type.Optional(Type.String({ description: 'One line for the log entry (what this pass changed and why); used only with log: true' })),
  create_patterns: Type.Optional(
    Type.Array(
      Type.Object({ name: Type.String({ description: 'Page slug (the file name without .md), e.g. "android-app-provider_leak"' }), content: Type.String({ description: 'Full markdown of the new pattern page' }) }),
    ),
  ),
  update_patterns: Type.Optional(
    Type.Array(Type.Object({ name: Type.String({ description: 'Existing pattern slug' }), edits: Type.Array(EDIT) })),
  ),
  update_index: Type.Optional(Type.String({ description: 'Full new index.md content; every pattern page must have exactly one row between the <!-- decx:index:start --> and <!-- decx:index:end --> markers, which must stay' })),
  resync_index: Type.Optional(Type.Boolean({ description: 'Rebuild the managed index block from the pattern pages instead of writing update_index' })),
  log: Type.Optional(Type.Boolean({ description: 'Also append a maintenance-log entry to wiki/logs.md — off by default, so logs.md and skill-impact.md stay at their seeded state' })),
});

function failure(error: unknown): Error {
  if (isWikiError(error)) {
    return new Error(`${error.code}: ${error.message}${error.hint === undefined ? '' : `\nhint: ${error.hint}`}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

function clip(text: string, where: string): string {
  const result = truncateHead(text, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  return result.truncated ? `${result.content}\n\n[${where}: output truncated at ${DEFAULT_MAX_LINES} lines / ${DEFAULT_MAX_BYTES} bytes]` : result.content;
}

interface RawConfig {
  workspaces?: { name?: unknown; root?: unknown }[];
  checkpoints?: { every?: unknown; unit?: unknown; inject?: unknown };
}

/** Checkpoint cadence; `decx.json` overrides the defaults. */
interface CheckpointSettings {
  every: number;
  unit: CheckpointUnit;
  inject: boolean;
}

/** Workspace roots plus the checkpoint cadence, both from `decx.json`. */
interface WorkspaceConfig {
  cwd: string;
  workspaces: Workspace[];
  checkpoints: CheckpointSettings;
}

const DEFAULT_CHECKPOINTS: CheckpointSettings = { every: 7, unit: 'round', inject: true };

async function readConfig(cwd: string): Promise<RawConfig | undefined> {
  const path = join(cwd, CONFIG_DIR_NAME, 'extensions', 'decx.json');
  try {
    return JSON.parse(await readFile(path, 'utf8')) as RawConfig;
  } catch {
    return undefined;
  }
}

function checkpointSettings(parsed: RawConfig | undefined): CheckpointSettings {
  const every = parsed?.checkpoints?.every;
  const unit = parsed?.checkpoints?.unit;
  return {
    every: typeof every === 'number' && Number.isInteger(every) && every > 0 ? every : DEFAULT_CHECKPOINTS.every,
    unit: unit === 'turn' || unit === 'round' ? unit : DEFAULT_CHECKPOINTS.unit,
    inject: parsed?.checkpoints?.inject !== false,
  };
}

/** The pi session a handler runs in; only the parts this extension touches. */
interface SessionCtx {
  cwd: string;
  sessionManager?: { getSessionId?: () => string };
  hasUI?: boolean;
  ui?: { notify(message: string, level?: string): void };
}

/** The ledger key pi reports for this session; ephemeral sessions share one. */
function sessionKey(ctx: SessionCtx): string {
  try {
    const id = ctx.sessionManager?.getSessionId?.();
    return typeof id === 'string' && id !== '' ? id : 'session';
  } catch {
    return 'session';
  }
}

export default function decx(pi: ExtensionAPI): void {
  const base = nodeFs();
  const fs: WikiFs = {
    ...base,
    // Wiki writes are file mutations: keep them in pi's queue so the built-in
    // edit/write tools cannot race this extension.
    async writeFile(path: string, text: string): Promise<void> {
      await withFileMutationQueue(path, async () => {
        await base.writeFile(path, text);
      });
    },
  };
  const stateDir = join(getAgentDir(), 'decx', 'sessions');
  let cache: WorkspaceConfig | undefined;
  let session: SessionState | undefined;
  let sessionFor = '';

  const config = async (cwd: string): Promise<WorkspaceConfig> => {
    if (cache === undefined || cache.cwd !== cwd) {
      const parsed = await readConfig(cwd);
      const configured = await readWorkspaceConfig(join(cwd, CONFIG_DIR_NAME, 'extensions', 'decx.json'), fs);
      cache = { cwd, workspaces: await discoverWorkspaces(cwd, fs, configured), checkpoints: checkpointSettings(parsed) };
    }
    return cache;
  };
  const workspaces = async (cwd: string): Promise<Workspace[]> => (await config(cwd)).workspaces;
  const options = async (cwd: string): Promise<CheckpointSettings> => (await config(cwd)).checkpoints;

  /** The checkpoint ledger of the session pi reports, reloaded when it changes. */
  const ledger = async (ctx: SessionCtx): Promise<SessionState> => {
    const key = sessionKey(ctx);
    if (session === undefined || sessionFor !== key) {
      sessionFor = key;
      session = await readSessionState(stateDir, key, fs);
    }
    return session;
  };
  const save = async (): Promise<void> => {
    if (session !== undefined) {
      await writeSessionState(stateDir, session, fs);
    }
  };

  const pick = async (cwd: string, name?: string): Promise<Workspace[]> => {
    const all = await workspaces(cwd);
    if (all.length === 0) {
      throw new Error('no decx workspace found: a project with a skills/ or wiki/ layer, or a "workspaces" entry in .pi/extensions/decx.json');
    }
    return name === undefined ? all : [requireWorkspace(all, name)];
  };

  pi.registerTool({
    name: 'decx_read',
    label: 'Decx Read',
    description:
      'Read a decx page: "index.md" (pattern catalog), "patterns/<slug>.md" (one consolidated pattern), "logs.md" (maintenance history), "skill-impact.md" (proposals and outcomes), "traces/<id>.md" (an immutable execution trace under raw/traces/) or "skills/<name>/SKILL.md".',
    promptSnippet: 'Read a wiki page, a raw trace or a skill file',
    parameters: Type.Object({ workspace: WORKSPACE, path: Type.String({ description: 'Path relative to the workspace root, e.g. "index.md", "patterns/<slug>.md" or "traces/<id>.md"' }) }),
    async execute(_toolCallId: string, params: { workspace: string; path: string }, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
      try {
        const [workspace] = await pick(ctx.cwd, params.workspace);
        const page = await readPage(workspace as Workspace, params.path, fs);
        return { content: [{ type: 'text' as const, text: clip(page.text, page.path) }], details: { path: page.path } };
      } catch (error) {
        throw failure(error);
      }
    },
  });

  pi.registerTool({
    name: 'decx_trace',
    label: 'Decx Trace',
    description:
      'Record an immutable raw trace of one execution — goal, exact commands, observations, outcome — under raw/traces/ at the workspace root. Traces are the evidence a maintenance pass consolidates into patterns: keep failures as well as successes, and never edit or delete one afterwards.',
    promptSnippet: 'Record an immutable run trace under raw/traces/',
    promptGuidelines: [
      'Record the commands you actually ran and the exact output or error text, not a summary of them.',
      'Corrections go into a new trace.',
    ],
    parameters: Type.Object({
      workspace: WORKSPACE,
      summary: Type.String({ description: 'One line: what the run tested' }),
      body: Type.String({ description: 'Markdown body: setup, commands, observations, exact errors' }),
      files: Type.Optional(Type.Array(Type.String({ description: 'Artifacts involved, e.g. "com.example.apk"' }))),
      outcome: Type.Optional(Type.String({ description: 'Short outcome label, e.g. confirmed, rejected, inconclusive, crash, exploit' })),
    }),
    async execute(
      _toolCallId: string,
      params: { workspace: string; summary: string; body: string; files?: string[]; outcome?: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      try {
        const [workspace] = await pick(ctx.cwd, params.workspace);
        const trace = await writeTrace(workspace as Workspace, params, fs);
        return { content: [{ type: 'text' as const, text: `recorded ${trace.path}` }], details: trace };
      } catch (error) {
        throw failure(error);
      }
    },
  });

  pi.registerTool({
    name: 'decx_maintain',
    label: 'Decx Maintain',
    description:
      'Maintenance pass: create or patch pattern pages in wiki/patterns/ and keep wiki/index.md in sync. A call must pass update_index or resync_index — the index has to stay current. Use it while consolidating traces, not during analysis.',
    promptSnippet: 'Create/update wiki patterns and the index',
    promptGuidelines: [
      'Patterns are patch-edited, never rewritten: use update_patterns with exact substrings taken from the current page, and keep every edit minimal.',
      'Patterns and the index are the wiki working set: logs.md and skill-impact.md stay at their seeded state by default, so never invent a log entry or a ledger row.',
      'Write wiki/ only through these tools — never edit a page by hand.',
      'The wiki is shared by every skill in the workspace: keep the index listing every pattern exactly once, and never nest a wiki inside a skill.',
      'A pattern page needs frontmatter (name, track) and the sections "## Match", "## Non-obvious", "## Reject"; Match is the trigger (keep its opener to one line — it becomes the index row), Non-obvious the mechanism-level insight, Reject when the finding is not reportable. track is one of android-app, android-framework, android-poc, native — a pattern is target knowledge, so DECX's own machinery (manager, report, PoC spec, analysis process) never gets a card.',
      'Mine the raw traces: state what the root cause was, the exact command sequence that proved it, and the workarounds you needed.',
    ],
    parameters: Type.Object({ workspace: WORKSPACE, patch: PATCH }),
    async execute(
      _toolCallId: string,
      params: { workspace: string; patch: Parameters<typeof applyMaintain>[1] },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      try {
        const [workspace] = await pick(ctx.cwd, params.workspace);
        const result = await applyMaintain(workspace as Workspace, params.patch, fs);
        const parts = [
          result.created.length > 0 ? `created ${result.created.join(', ')}` : '',
          result.updated.length > 0 ? `updated ${result.updated.join(', ')}` : '',
          result.resynced ? 'index resynced' : `index rows: ${result.indexRows}`,
        ].filter((part) => part !== '');
        return { content: [{ type: 'text' as const, text: `wiki updated — ${parts.join('; ')}` }], details: result };
      } catch (error) {
        throw failure(error);
      }
    },
  });

  pi.registerTool({
    name: 'decx_propose',
    label: 'Decx Propose',
    description:
      'Record one atomic proposal to change a skill (SKILL.md, PURPOSE.md or a reference) in wiki/skill-impact.md, with the evidence that justifies it and, once gated, the validation score. Pass an existing id to mark a proposal accepted or rejected and record the outcome. A rejected proposal rolls the skill back; the wiki and this ledger stay. This tool only records: it never edits the skill, so apply the accepted change yourself and re-run decx_check.',
    promptSnippet: 'Record a one-skill proposal in the ledger',
    promptGuidelines: [
      'One proposal changes exactly one file in one skill.',
      'Cite the wiki evidence (pattern slug or raw trace id) that motivates the change.',
      'The skill is distilled from the wiki, not the other way round — and it must stay complete for execution, so never replace an execution-critical rule with a pointer to the wiki.',
      'Record the validation outcome honestly: "applied, no measurement" is a valid outcome, and a lint pass is not an evaluation.',
    ],
    parameters: Type.Object({
      workspace: WORKSPACE,
      target: Type.String({ description: 'Skill file to change, e.g. "skills/decx-vulnhunt/SKILL.md"' }),
      change: Type.String({ description: 'The atomic change, e.g. "add a provider-leak gate before reporting"' }),
      evidence: Type.Optional(Type.String({ description: 'Pattern slug(s) or raw trace id(s) supporting it' })),
      score: Type.Optional(Type.String({ description: 'Validation score that gated the change, e.g. "0.61 > 0.52 (baseline)" — omit while it is untested' })),
      id: Type.Optional(Type.String({ description: 'Existing proposal id to update instead of creating one' })),
      status: Type.Optional(Type.String({ description: 'proposed (default), accepted or rejected' })),
      outcome: Type.Optional(Type.String({ description: 'What happened when it was applied, e.g. a score or a review verdict' })),
    }),
    async execute(
      _toolCallId: string,
      params: { workspace: string; target: string; change: string; evidence?: string; score?: string; id?: string; status?: string; outcome?: string },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: { cwd: string },
    ) {
      try {
        const [workspace] = await pick(ctx.cwd, params.workspace);
        const record = await recordProposal(workspace as Workspace, params as Parameters<typeof recordProposal>[1], fs);
        return { content: [{ type: 'text' as const, text: `${record.id} ${record.status} in ${record.file}` }], details: record };
      } catch (error) {
        throw failure(error);
      }
    },
  });

  pi.registerTool({
    name: 'decx_check',
    label: 'Decx Check',
    description: 'Lint the workspace structure: pattern pages and index coverage in wiki/, relative links across wiki/ and skills/, PURPOSE.md presence and the skill-impact ledger. Structural only — it does not evaluate analysis performance.',
    promptSnippet: 'Lint the wiki and the skill structure',
    parameters: Type.Object({ workspace: Type.Optional(WORKSPACE) }),
    async execute(_toolCallId: string, params: { workspace?: string }, _signal: unknown, _onUpdate: unknown, ctx: { cwd: string }) {
      try {
        const targets = await pick(ctx.cwd, params.workspace);
        const states = await Promise.all(targets.map((target) => status(target, fs)));
        const lines = states.map(describeStatus);
        const findings: LintFinding[] = states.flatMap((state) => state.findings);
        const text = [...lines, '', ...findings.map(describeFinding)].join('\n').trim();
        return { content: [{ type: 'text' as const, text }], details: { states, findings } };
      } catch (error) {
        throw failure(error);
      }
    },
  });

  pi.registerTool({
    name: 'decx_checkpoint',
    label: 'Decx Checkpoint',
    description:
      'Record a session checkpoint — goal, verified facts, steps taken, next action — in this session\'s ledger. The extension asks for one every N rounds or turns.',
    promptSnippet: 'Record goal/facts/steps/next for this session',
    promptGuidelines: [
      'A fact counts only with its proof: cite the command output or the file:line, and say when something is still an assumption.',
      'Keep the goal in the user\'s words and note if they changed it.',
      'Write the checkpoint before continuing the work, not after.',
    ],
    parameters: Type.Object({
      goal: Type.String({ description: 'One line: what the user asked for' }),
      facts: Type.Array(Type.String({ description: 'A verified fact, with the command or file:line that proves it' })),
      steps: Type.Array(Type.String({ description: 'A step taken, marked done or unfinished' })),
      next: Type.String({ description: 'One line: the single next action' }),
      decisions: Type.Optional(Type.Array(Type.String({ description: 'A decision taken, with the reason it won' }))),
    }),
    async execute(
      _toolCallId: string,
      params: { goal: string; facts: string[]; steps: string[]; next: string; decisions?: string[] },
      _signal: unknown,
      _onUpdate: unknown,
      ctx: SessionCtx,
    ) {
      try {
        const state = await ledger(ctx);
        const checkpoint = recordCheckpoint(state, params, new Date());
        await save();
        return {
          content: [{ type: 'text' as const, text: checkpointBlock(checkpoint) }],
          details: { checkpoint, ledger: join(stateDir, stateFileName(state.session)) },
        };
      } catch (error) {
        throw failure(error);
      }
    },
  });

  pi.registerCommand('decx', {
    description: 'Show the decx status of every workspace, the session checkpoint ledger ("checkpoints"), or rebuild the indexes ("resync")',
    handler: async (args: string, ctx: SessionCtx) => {
      const targets = await workspaces(ctx.cwd);
      if (targets.length === 0) {
        ctx.ui?.notify('no decx workspace found', 'warning');
        return;
      }
      if (args.trim().startsWith('resync')) {
        const lines: string[] = [];
        for (const target of targets) {
          cache = undefined;
          await ensureWorkspace(target, fs);
          const result = await resyncIndex(target, fs);
          lines.push(`${target.name}: ${result.total} patterns (added ${result.added.length}, removed ${result.removed.length})`);
        }
        ctx.ui?.notify(lines.join('\n'), 'info');
        return;
      }
      if (args.trim().startsWith('checkpoints')) {
        const state = await ledger(ctx);
        const settings = await options(ctx.cwd);
        const head = `round ${state.rounds} · turn ${state.turns} · checkpoint every ${settings.every} ${settings.unit}${settings.every === 1 ? '' : 's'}${settings.inject ? '' : ' (counting only)'}`;
        const entries = state.checkpoints.map(describeCheckpoint);
        ctx.ui?.notify([head, ...(entries.length === 0 ? ['no checkpoint recorded yet'] : entries)].join('\n'), 'info');
        return;
      }
      const states = await Promise.all(targets.map((target) => status(target, fs)));
      ctx.ui?.notify(states.map(describeStatus).join('\n'), 'info');
    },
  });

  // Round and turn counters feed the checkpoint cadence.  A message another
  // extension injected is not a user round, so it does not count.
  pi.on('input', async (event: { source?: string }, ctx: SessionCtx) => {
    if (event.source === 'extension') {
      return undefined;
    }
    const state = await ledger(ctx);
    state.rounds += 1;
    await save();
    return undefined;
  });

  pi.on('turn_start', async (_event: unknown, ctx: SessionCtx) => {
    const state = await ledger(ctx);
    state.turns += 1;
    await save();
    const settings = await options(ctx.cwd);
    if (!settings.inject || settings.unit !== 'turn') {
      return undefined;
    }
    const due = checkpointDue(state, settings.every, settings.unit);
    if (due !== undefined) {
      // `steer` lands after this turn's tool calls, before the next LLM call.
      pi.sendMessage(
        { customType: 'decx-checkpoint', content: checkpointDirective(state, due, settings.every, settings.unit), display: true },
        { deliverAs: 'steer' },
      );
    }
    return undefined;
  });

  pi.on('resources_discover', async (_event: unknown, ctx: { cwd: string }) => {
    const paths: string[] = [];
    for (const workspace of await workspaces(ctx.cwd)) {
      for (const dir of await skillDirs(workspace, fs)) {
        paths.push(join(workspace.skills, dir, 'SKILL.md'));
      }
    }
    return paths.length === 0 ? {} : { skillPaths: paths };
  });

  pi.on('before_agent_start', async (event: { systemPrompt?: string }, ctx: SessionCtx) => {
    const targets = await workspaces(ctx.cwd);
    const state = await ledger(ctx);
    const settings = await options(ctx.cwd);
    if (targets.length === 0 || !settings.inject) {
      return undefined;
    }
    // The wiki is the maintenance layer: the inference agent works from the
    // skills alone, so nothing here advertises the catalog or asks for a read.
    const previous = lastCheckpoint(state);
    const due = settings.unit === 'round' ? checkpointDue(state, settings.every, settings.unit) : undefined;
    const lines: string[] = [];
    if (previous !== undefined) {
      lines.push('', `Decx checkpoint — ${describeCheckpoint(previous)}. Resume from it after a compaction, and re-check it against the newest user message before continuing.`);
    }
    const directive = due === undefined ? undefined : checkpointDirective(state, due, settings.every, settings.unit);
    if (lines.length === 0 && directive === undefined) {
      return undefined;
    }
    // `systemPrompt` replaces the chained prompt, so this has to append to the
    // prompt it was given: returning only the block would drop pi's own prompt.
    const given = typeof event.systemPrompt === 'string' ? event.systemPrompt : '';
    const block = lines.join('\n');
    const out: { systemPrompt: string; message?: { customType: string; content: string; display: boolean } } = {
      systemPrompt: given === '' || block === '' ? `${given}${block}` : `${given}\n${block}`,
    };
    if (directive !== undefined) {
      out.message = { customType: 'decx-checkpoint', content: directive, display: true };
    }
    return out;
  });

  pi.on('session_start', async (_event: unknown, ctx: SessionCtx) => {
    const targets = await workspaces(ctx.cwd);
    const state = await ledger(ctx);
    const checkpoints = state.checkpoints.length === 0 ? 'no checkpoint yet' : `${state.checkpoints.length} checkpoint(s), newest #${state.checkpoints.at(-1)?.n ?? 0}`;
    const path = join(ctx.cwd, CONFIG_DIR_NAME, 'extensions', 'decx.json');
    if (targets.length > 0) {
      ctx.ui?.notify(`decx: ${targets.map((target) => target.name).join(', ')} — ${targets.length === 1 ? `${targets[0].wiki}, ${targets[0].skills}` : 'multiple workspaces'} — round ${state.rounds} · turn ${state.turns} · ${checkpoints}`, 'info');
    } else if (await fs.exists(path)) {
      ctx.ui?.notify('decx: no workspace matches the configured roots', 'warning');
    }
  });
}
