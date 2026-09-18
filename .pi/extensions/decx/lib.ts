/**
 * Decx core.
 *
 * A decx workspace is a project with WikiSkill's three sibling layers:
 * `raw/traces/` holds immutable execution traces, `wiki/` holds the shared pattern
 * catalog (`index.md`, `patterns/*.md`), the chronological maintenance log
 * (`logs.md`) and the skill-impact ledger (`skill-impact.md`), and `skills/`
 * holds the execution procedures (`<name>/SKILL.md`, `PURPOSE.md`, references).
 *
 * The wiki is the maintenance layer and is never rolled back; a rejected
 * proposal rolls back the skill only. Skills stay complete for execution — the
 * inference agent reads them, not the wiki.
 *
 * Everything here is pure logic over an injected `WikiFs`, so the pi extension,
 * the CLI and the tests share exactly one implementation.
 */

export interface WikiFs {
  readFile(path: string): Promise<string>;
  writeFile(path: string, text: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  listDir(path: string): Promise<string[]>;
  mkdirp(path: string): Promise<void>;
}

export const FILES = {
  index: 'index.md',
  logs: 'logs.md',
  impact: 'skill-impact.md',
  patterns: 'patterns',
} as const;

/** The three sibling layers of a WikiSkill workspace. */
export const LAYERS = {
  raw: 'raw',
  wiki: 'wiki',
  skills: 'skills',
} as const;

/** Inside the raw layer: one file per execution record. `traces/<id>.md` is its read alias. */
export const RAW_TRACES = 'traces';

export const INDEX_START = '<!-- decx:index:start -->';
export const INDEX_END = '<!-- decx:index:end -->';
/** A managed index row: `` - `slug` — trigger `` (rows are grouped by track) */
export const INDEX_ROW = /^- `([^`]+)` — (.*)$/;
export const PATTERN_SECTIONS = ['Match', 'Non-obvious', 'Reject'];
export const PATTERN_NAME = /^[a-z0-9][a-z0-9_-]*$/;
export const PROPOSAL_STATUS = ['proposed', 'accepted', 'rejected'] as const;
export type ProposalStatus = (typeof PROPOSAL_STATUS)[number];

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

/** One workspace: the project root and its three layer directories. */
export interface Workspace {
  name: string;
  root: string;
  wiki: string;
  raw: string;
  skills: string;
}

export interface PatternPage {
  name: string;
  track: string;
  sections: Record<string, string>;
  body: string;
  data: Record<string, string>;
}

export interface LintFinding {
  level: 'error' | 'warn';
  area: 'wiki' | 'skill';
  file: string;
  message: string;
}

export interface WorkspaceStatus {
  name: string;
  root: string;
  skills: string[];
  patterns: number;
  indexRows: number;
  missingRows: string[];
  staleRows: string[];
  traces: number;
  openProposals: number;
  lastLog?: string;
  findings: LintFinding[];
}

/* ------------------------------------------------------------------ paths */

export function joinPath(...parts: string[]): string {
  return parts
    .filter((part) => part !== '')
    .join('/')
    .replaceAll(/\/{2,}/g, '/');
}

/** Rejects anything that is not a plain relative path inside the workspace. */
export function normalizeRel(rel: string): string {
  const cleaned = rel.trim().replaceAll('\\', '/').replace(/^\.\//, '');
  if (cleaned === '' || cleaned.startsWith('/') || /^[a-zA-Z]:/.test(cleaned)) {
    throw new WikiError('BAD_PATH', `"${rel}" is not a path inside the workspace`, 'paths are relative, e.g. "patterns/android-app-exported_access.md"');
  }
  const parts = cleaned.split('/').filter((part) => part !== '' && part !== '.');
  if (parts.includes('..')) {
    throw new WikiError('BAD_PATH', `"${rel}" escapes the workspace`, 'paths are relative, e.g. "patterns/android-app-exported_access.md"');
  }
  return parts.join('/');
}

export async function listFiles(fs: WikiFs, dir: string, suffix = '.md'): Promise<string[]> {
  let names: string[];
  try {
    names = await fs.listDir(dir);
  } catch {
    return [];
  }
  return names.filter((name) => name.endsWith(suffix)).sort();
}

/* ---------------------------------------------------------------- parsing */

export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (match === null) {
    return { data: {}, body: text };
  }
  const data: Record<string, string> = {};
  for (const raw of match[1].split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) {
      continue;
    }
    const at = line.indexOf(':');
    if (at === -1) {
      continue;
    }
    const key = line.slice(0, at).trim();
    const value = line
      .slice(at + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (key !== '') {
      data[key] = value;
    }
  }
  return { data, body: text.slice(match[0].length) };
}

export function parseSections(body: string): Record<string, string> {
  const sections: Record<string, string> = {};
  let current: string | undefined;
  for (const line of body.split(/\r?\n/)) {
    const heading = /^##\s+(.+?)\s*$/.exec(line);
    if (heading !== null) {
      current = heading[1];
      sections[current] = '';
      continue;
    }
    if (current !== undefined) {
      sections[current] += `${line}\n`;
    }
  }
  for (const key of Object.keys(sections)) {
    sections[key] = sections[key].trim();
  }
  return sections;
}

export function parsePattern(text: string, fallbackName = ''): PatternPage {
  const { data, body } = parseFrontmatter(text);
  const title = /^#\s+(.+?)\s*$/m.exec(body)?.[1];
  const name = (data.name ?? title ?? fallbackName).trim().replace(/^`|`$/g, '');
  return {
    name,
    track: (data.track ?? '').trim(),
    sections: parseSections(body),
    body,
    data,
  };
}

/** One-line trigger text for the index, taken from a pattern's Match section. */
export function firstSentence(text: string, limit = 140): string {
  const flat = text.replace(/\s+/g, ' ').replaceAll('`', '').trim();
  const sentence = /^(.*?[.!?])\s/.exec(flat)?.[1] ?? flat;
  const line = sentence.trim();
  if (line.length <= limit) {
    return line;
  }
  const cut = line.slice(0, limit);
  const at = cut.lastIndexOf(' ');
  return `${at > 40 ? cut.slice(0, at) : cut}…`;
}

/** A pattern is identified by its file slug (`<track>-<name>` or a plain name). */
export function indexRow(slug: string, page: PatternPage): string {
  const trigger = firstSentence(page.sections['Match'] ?? page.sections['When'] ?? '');
  return `- \`${slug}\` — ${trigger}`;
}

export function indexRows(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const match = INDEX_ROW.exec(line.trim());
    if (match !== null) {
      out.push(match[1]);
    }
  }
  return out;
}

/* ------------------------------------------------------------- workspaces */

async function safeListDirs(fs: WikiFs, dir: string): Promise<string[]> {
  try {
    return (await fs.listDir(dir)).sort();
  } catch {
    return [];
  }
}

export function workspaceAt(name: string, root: string): Workspace {
  return {
    name,
    root,
    wiki: joinPath(root, LAYERS.wiki),
    raw: joinPath(root, LAYERS.raw),
    skills: joinPath(root, LAYERS.skills),
  };
}

/** Reads `{ "workspaces": [{ "name", "root" }] }` from a decx config file, ignoring anything malformed. */
export async function readWorkspaceConfig(path: string, fs: WikiFs): Promise<{ name: string; root: string }[]> {
  try {
    const parsed = JSON.parse(await fs.readFile(path)) as { workspaces?: unknown };
    const list = Array.isArray(parsed?.workspaces) ? parsed.workspaces : [];
    const out: { name: string; root: string }[] = [];
    for (const item of list) {
      const entry = item as { name?: unknown; root?: unknown };
      if (typeof entry?.name === 'string' && typeof entry.root === 'string') {
        out.push({ name: entry.name, root: entry.root });
      }
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * A workspace is the project itself, with its three layers at the root. The
 * optional `.pi/extensions/decx.json` lists them (`{ "workspaces": [{"name",
 * "root"}] }`); without it the current project is the single workspace, provided
 * it already has a `skills/` or `wiki/` layer. A skill-local `skills/<name>/wiki`
 * is deliberately not a workspace: the wiki is shared, not per skill.
 */
export async function discoverWorkspaces(
  cwd: string,
  fs: WikiFs,
  extra: { name: string; root: string }[] = [],
): Promise<Workspace[]> {
  const found = new Map<string, Workspace>();
  for (const item of extra) {
    const raw = item.root.trim();
    const root = raw.startsWith('/') || /^[A-Za-z]:/.test(raw) ? normalizeRoot(raw) : normalizeRoot(joinPath(cwd, raw));
    found.set(item.name, workspaceAt(item.name, root));
  }
  if (found.size === 0) {
    const root = normalizeRoot(cwd);
    const hasSkills = (await safeListDirs(fs, joinPath(root, LAYERS.skills))).length > 0;
    if (hasSkills || (await fs.exists(joinPath(root, LAYERS.wiki)))) {
      const name = root.split('/').filter((part) => part !== '').at(-1) ?? 'workspace';
      found.set(name, workspaceAt(name, root));
    }
  }
  return [...found.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Collapse `.` and duplicate segments so configured roots compare and render predictably. */
function normalizeRoot(path: string): string {
  const parts = path.replaceAll('\\', '/').split('/');
  return parts.filter((part, index) => part !== '.' && !(part === '' && index !== 0)).join('/') || '.';
}

/** The skill directories of a workspace: a directory that has a SKILL.md. */
export async function skillDirs(ws: Workspace, fs: WikiFs): Promise<string[]> {
  const out: string[] = [];
  for (const dir of await safeListDirs(fs, ws.skills)) {
    if (await fs.exists(joinPath(ws.skills, dir, 'SKILL.md'))) {
      out.push(dir);
    }
  }
  return out;
}

/** The execution traces of a workspace: every markdown file under `raw/traces/`. */
async function traceFiles(ws: Workspace, fs: WikiFs): Promise<string[]> {
  return (await listFiles(fs, joinPath(ws.raw, RAW_TRACES))).filter((name) => name.endsWith('.md'));
}

export function requireWorkspace(workspaces: Workspace[], name: string): Workspace {
  const found = workspaces.find((workspace) => workspace.name === name);
  if (found === undefined) {
    throw new WikiError('UNKNOWN_WORKSPACE', `no workspace named "${name}"`, `known workspaces: ${workspaces.map((w) => w.name).join(', ') || '(none)'}`);
  }
  return found;
}

/** Creates the files a workspace needs, without touching existing content. */
export async function ensureWorkspace(ws: Workspace, fs: WikiFs): Promise<string[]> {
  const created: string[] = [];
  await fs.mkdirp(joinPath(ws.wiki, FILES.patterns));
  await fs.mkdirp(ws.raw);
  await fs.mkdirp(joinPath(ws.raw, RAW_TRACES));
  const seeds: [string, string][] = [
    [FILES.index, seedIndex(ws)],
    [FILES.logs, `# maintenance log — ${ws.name}\n`],
    [FILES.impact, impactHeader()],
  ];
  for (const [name, text] of seeds) {
    const path = joinPath(ws.wiki, name);
    if (!(await fs.exists(path))) {
      await fs.writeFile(path, text);
      created.push(name);
    }
  }
  return created;
}

function seedIndex(ws: Workspace): string {
  return [
    '---',
    `decx: ${ws.name}`,
    'patterns: 0',
    '---',
    '',
    `# ${ws.name} pattern index`,
    '',
    'One row per pattern page: `` - `slug` — trigger ``, grouped by track. Add or',
    'change pages only through `decx_maintain`.',
    '',
    INDEX_START,
    INDEX_END,
    '',
  ].join('\n');
}

/** The ledger table shape every row must match: id | date | target | change | evidence | gate score | status | outcome. */
export const IMPACT_COLUMNS = 8;
export const IMPACT_SCHEMA = '| id | date | target | change | evidence | gate score | status | outcome |';

function impactHeader(): string {
  return [
    '# skill impact',
    '',
    'Every skill change proposed from wiki evidence, newest last. One proposal',
    'changes one skill; a rejected proposal rolls the skill back and leaves this',
    'ledger and the patterns untouched. `gate score` is the validation result that',
    'gated the change and `outcome` records what followed.',
    '',
    IMPACT_SCHEMA,
    '| --- | --- | --- | --- | --- | --- | --- | --- |',
    '',
  ].join('\n');
}

/* ------------------------------------------------------------------- read */

export async function readPage(ws: Workspace, rel: string, fs: WikiFs): Promise<{ path: string; text: string }> {
  const clean = normalizeRel(rel);
  const alias = clean === RAW_TRACES || clean.startsWith(`${RAW_TRACES}/`) ? joinPath(ws.raw, clean) : undefined;
  for (const path of [
    joinPath(ws.wiki, clean),
    joinPath(ws.raw, clean),
    joinPath(ws.raw, RAW_TRACES, clean),
    ...(alias === undefined ? [] : [alias]),
    joinPath(ws.skills, clean),
    joinPath(ws.root, clean),
  ]) {
    if (await fs.exists(path)) {
      return { path, text: await fs.readFile(path) };
    }
  }
  const available = await workspaceListing(ws, fs);
  throw new WikiError('NOT_FOUND', `no decx page ${clean} in ${ws.name}`, `available: ${available.join(', ') || '(none)'}`);
}

export async function workspaceListing(ws: Workspace, fs: WikiFs): Promise<string[]> {
  const top = (await safeListDirs(fs, ws.wiki)).filter((name) => name.endsWith('.md'));
  const patterns = (await listFiles(fs, joinPath(ws.wiki, FILES.patterns))).map((name) => `${FILES.patterns}/${name}`);
  const raw = (await traceFiles(ws, fs)).map((name) => `${LAYERS.raw}/${RAW_TRACES}/${name}`);
  const skills = (await skillDirs(ws, fs)).map((name) => `${LAYERS.skills}/${name}/SKILL.md`);
  return [...top, ...patterns, ...raw, ...skills];
}

/* ------------------------------------------------------------------ trace */

export interface TraceInput {
  summary: string;
  body: string;
  files?: string[];
  outcome?: string;
}

export function traceId(summary: string, now: Date, seen: number): string {
  const slug = summary
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .slice(0, 48)
    .replaceAll(/-+$/g, '');
  const stamp = now.toISOString().replaceAll(/[-:]/g, '').slice(0, 15).replace('T', '-');
  return `${stamp}-${slug === '' ? 'run' : slug}${seen === 0 ? '' : `-${seen + 1}`}`;
}

export async function writeTrace(
  ws: Workspace,
  input: TraceInput,
  fs: WikiFs,
  now = new Date(),
): Promise<{ id: string; path: string }> {
  if (input.summary.trim() === '') {
    throw new WikiError('BAD_TRACE', 'a trace needs a summary', 'one line saying what the run tested');
  }
  if (input.body.trim() === '') {
    throw new WikiError('BAD_TRACE', 'a trace needs a body', 'include the exact commands and error text');
  }
  await ensureWorkspace(ws, fs);
  const existing = await traceFiles(ws, fs);
  let seen = 0;
  let id = traceId(input.summary, now, seen);
  while (existing.includes(`${id}.md`)) {
    seen += 1;
    id = traceId(input.summary, now, seen);
  }
  const rel = `${LAYERS.raw}/${RAW_TRACES}/${id}.md`;
  const header = [
    '---',
    `id: ${id}`,
    `date: ${now.toISOString()}`,
    `workspace: ${ws.name}`,
    ...(input.files !== undefined && input.files.length > 0 ? [`files: ${input.files.join(', ')}`] : []),
    ...(input.outcome !== undefined && input.outcome.trim() !== '' ? [`outcome: ${input.outcome.trim()}`] : []),
    '---',
    '',
    `# ${input.summary.trim()}`,
    '',
    input.body.trim(),
    '',
  ].join('\n');
  await fs.writeFile(joinPath(ws.root, rel), header);
  return { id, path: rel };
}

/* ---------------------------------------------------------------- maintain */

export interface PatternEdit {
  op: 'append' | 'replace' | 'insert_after';
  content: string;
  target?: string;
}

export interface MaintainPatch {
  /** One line for the maintenance log entry, used only with `log: true`. */
  summary?: string;
  create_patterns?: { name: string; content: string }[];
  update_patterns?: { name: string; edits: PatternEdit[] }[];
  update_index?: string;
  /**
   * Also append a maintenance-log entry to wiki/logs.md. Off by default: a maintenance
   * pass changes patterns and the index, and leaves wiki/logs.md and
   * wiki/skill-impact.md at the state they were seeded with.
   */
  log?: boolean;
  /** Rebuild the managed index block from the pattern pages instead of editing it. */
  resync_index?: boolean;
}

export interface MaintainResult {
  created: string[];
  updated: string[];
  indexRows: number;
  resynced: boolean;
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle === '') {
    return 0;
  }
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1) {
    count += 1;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

function applyEdit(text: string, edit: PatternEdit, where: string): string {
  if (edit.op === 'append') {
    return `${text.replace(/\s*$/, '')}\n${edit.content.replace(/\s*$/, '')}\n`;
  }
  const target = edit.target ?? '';
  if (target === '') {
    throw new WikiError('BAD_EDIT', `${where}: "${edit.op}" needs a target`, 'the target must be an exact substring of the page');
  }
  const hits = countOccurrences(text, target);
  if (hits === 0) {
    throw new WikiError('EDIT_TARGET_MISSING', `${where}: target not found: ${JSON.stringify(target.slice(0, 80))}`, 'read the page first');
  }
  if (hits > 1) {
    throw new WikiError('EDIT_TARGET_AMBIGUOUS', `${where}: target appears ${hits} times: ${JSON.stringify(target.slice(0, 80))}`, 'include more surrounding text so the target is unique');
  }
  return edit.op === 'replace'
    ? text.replace(target, edit.content)
    : text.replace(target, `${target}\n${edit.content.replace(/\s*$/, '')}`);
}

function validatePatternContent(name: string, content: string, where: string): string[] {
  const page = parsePattern(content, name);
  const problems: string[] = [];
  const conforms = page.name === name || (page.track !== '' && name === `${page.track}-${page.name}`);
  if (!conforms) {
    problems.push(`frontmatter name is ${JSON.stringify(page.name)} but the file is ${name}`);
  }
  if (page.track === '') {
    problems.push(`frontmatter needs a track (${TRACK_ORDER.join(' | ')})`);
  }
  for (const section of PATTERN_SECTIONS) {
    if ((page.sections[section] ?? '') === '') {
      problems.push(`missing "## ${section}" section`);
    }
  }
  if (problems.length > 0) {
    throw new WikiError(
      'INVALID_PATTERN',
      `${where}: ${problems.join('; ')}`,
      `a pattern page needs frontmatter (name, track) and the sections ${PATTERN_SECTIONS.map((s) => `## ${s}`).join(', ')}`,
    );
  }
  return [];
}

export async function patternPages(ws: Workspace, fs: WikiFs): Promise<{ name: string; page: PatternPage }[]> {
  const out: { name: string; page: PatternPage }[] = [];
  for (const file of await listFiles(fs, joinPath(ws.wiki, FILES.patterns))) {
    const slug = file.replace(/\.md$/, '');
    const text = await fs.readFile(joinPath(ws.wiki, FILES.patterns, file));
    out.push({ name: slug, page: parsePattern(text, slug) });
  }
  return out;
}

/**
 * The catalog groups, in the order the index lists them. A card is named
 * `<platform>-<component>-<summary>` and its track is the leading
 * `<platform>-<component>`, which names the target rather than the analyzer: Android
 * cards live under `android-app` / `android-framework`, a PoC harness under
 * `android-poc`, and a native binary under `native`. DECX's own machinery (manager,
 * report, PoC spec, analysis process) is not target knowledge and never gets a track —
 * it lives in the skill that owns it.
 */
export const TRACK_ORDER = ['android-app', 'android-framework', 'android-poc', 'native'];

/** Heading text per track in the managed index block. */
export const TRACK_TITLES: Record<string, string> = {
  'android-app': 'Android app',
  'android-framework': 'Android framework',
  'android-poc': 'Android PoC',
  'native': 'Native',
};

export async function buildIndexBlock(ws: Workspace, fs: WikiFs): Promise<string> {
  const groups = TRACK_ORDER.map((track) => ({ track, rows: [] as string[] }));
  const other: string[] = [];
  for (const { name, page } of await patternPages(ws, fs)) {
    const group = groups.find((entry) => entry.track === page.track);
    (group === undefined ? other : group.rows).push(indexRow(name, page));
  }
  const sections = groups
    .filter((group) => group.rows.length > 0)
    .map((group) => [`### ${TRACK_TITLES[group.track] ?? group.track} (${group.rows.length})`, ...group.rows.sort((a, b) => a.localeCompare(b))].join('\n'));
  if (other.length > 0) {
    sections.push([`### Other (${other.length})`, ...other.sort((a, b) => a.localeCompare(b))].join('\n'));
  }
  return sections.join('\n\n');
}

function withIndexBlock(index: string, block: string, count: number): string {
  const start = index.indexOf(INDEX_START);
  const end = index.indexOf(INDEX_END);
  const body = `${INDEX_START}\n${block}${block === '' ? '' : '\n'}${INDEX_END}`;
  const next = start !== -1 && end > start ? `${index.slice(0, start)}${body}${index.slice(end + INDEX_END.length)}` : `${index.replace(/\s*$/, '')}\n\n${body}\n`;
  return next.replace(/^(---\r?\n[\s\S]*?\r?\n---)/, (front) => front.replace(/^patterns:.*$/m, `patterns: ${count}`));
}

export async function resyncIndex(ws: Workspace, fs: WikiFs): Promise<{ added: string[]; removed: string[]; total: number }> {
  await ensureWorkspace(ws, fs);
  const path = joinPath(ws.wiki, FILES.index);
  const before = await fs.readFile(path);
  const pages = await patternPages(ws, fs);
  const block = await buildIndexBlock(ws, fs);
  const previous = indexRows(before);
  const current = pages.map(({ name }) => name);
  const added = current.filter((name) => !previous.includes(name)).sort();
  const removed = previous.filter((name) => !current.includes(name)).sort();
  await fs.writeFile(path, withIndexBlock(before, block, pages.length));
  return { added, removed, total: pages.length };
}

export async function applyMaintain(
  ws: Workspace,
  patch: MaintainPatch,
  fs: WikiFs,
  now = new Date(),
): Promise<MaintainResult> {
  const created: string[] = [];
  const updated: string[] = [];
  await ensureWorkspace(ws, fs);
  if (patch.update_index === undefined && patch.resync_index !== true) {
    throw new WikiError('INDEX_REQUIRED', 'the index must stay current', 'pass update_index (the full index.md, one row per pattern) or resync_index to rebuild the managed block');
  }

  for (const item of patch.create_patterns ?? []) {
    const name = item.name.trim();
    if (!PATTERN_NAME.test(name)) {
      throw new WikiError('BAD_PATTERN_NAME', `"${item.name}" is not a pattern name`, 'names are lower-case slugs such as "exported-access"');
    }
    const path = joinPath(ws.wiki, FILES.patterns, `${name}.md`);
    if (await fs.exists(path)) {
      throw new WikiError('PATTERN_EXISTS', `pattern ${name} already exists`, 'use update_patterns with exact-substring edits instead of rewriting the page');
    }
    validatePatternContent(name, item.content, `create ${name}`);
    await fs.writeFile(path, item.content.replace(/\s*$/, '') + '\n');
    created.push(name);
  }

  for (const item of patch.update_patterns ?? []) {
    const name = item.name.trim();
    const path = joinPath(ws.wiki, FILES.patterns, `${name}.md`);
    if (!(await fs.exists(path))) {
      throw new WikiError('PATTERN_MISSING', `no pattern page ${name}`, 'create it first (create_patterns) or check the spelling');
    }
    let text = await fs.readFile(path);
    for (const edit of item.edits) {
      text = applyEdit(text, edit, `update ${name}`);
    }
    validatePatternContent(name, text, `update ${name}`);
    await fs.writeFile(path, text.replace(/\s*$/, '') + '\n');
    updated.push(name);
  }

  let resynced = false;
  if (patch.resync_index === true) {
    await resyncIndex(ws, fs);
    resynced = true;
  } else if (patch.update_index !== undefined) {
    const pages = (await patternPages(ws, fs)).map(({ name }) => name);
    const listed = indexRows(patch.update_index);
    const missing = pages.filter((name) => !listed.includes(name));
    const stale = listed.filter((name) => !pages.includes(name));
    if (missing.length > 0 || stale.length > 0) {
      const details = [
        missing.length > 0 ? `missing rows: ${missing.join(', ')}` : '',
        stale.length > 0 ? `rows without a page: ${stale.join(', ')}` : '',
      ]
        .filter((part) => part !== '')
        .join('; ');
      throw new WikiError('INDEX_MISMATCH', `update_index does not match the pattern pages (${details})`, 'the index lists every pattern exactly once; use resync_index to rebuild the managed block');
    }
    await fs.writeFile(joinPath(ws.wiki, FILES.index), patch.update_index.replace(/\s*$/, '') + '\n');
  }
  const indexRowsNow = indexRows(await fs.readFile(joinPath(ws.wiki, FILES.index))).length;

  if (patch.log === true) {
    const touch = [
      created.length > 0 ? `created ${created.join(', ')}` : '',
      updated.length > 0 ? `updated ${updated.join(', ')}` : '',
      resynced ? 'index resynced' : '',
    ].filter((part) => part !== '');
    const line = `- ${now.toISOString()} maintain: ${patch.summary?.trim() || 'no summary'} — ${touch.length > 0 ? touch.join('; ') : 'no pattern change'}`;
    const logs = joinPath(ws.wiki, FILES.logs);
    await fs.writeFile(logs, `${(await fs.readFile(logs)).replace(/\s*$/, '')}\n${line}\n`);
  }
  return { created, updated, indexRows: indexRowsNow, resynced };
}

/* ---------------------------------------------------------------- ledger */

export interface ProposalInput {
  target: string;
  change: string;
  evidence?: string;
  /** Validation score from the gating run, e.g. "0.61 > 0.52 (baseline)". */
  score?: string;
  /** Update an existing proposal instead of adding a new one. */
  id?: string;
  status?: ProposalStatus;
  outcome?: string;
}

function cell(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll(/\r?\n+/g, ' ').trim();
}

function splitRow(line: string): string[] {
  return line
    .replace(/^\|\s*/, '')
    .replace(/\s*\|$/, '')
    .split(/(?<!\\)\|/)
    .map((part) => part.replaceAll('\\|', '|').trim());
}

export async function recordProposal(
  ws: Workspace,
  input: ProposalInput,
  fs: WikiFs,
  now = new Date(),
): Promise<{ id: string; status: ProposalStatus; file: string }> {
  await ensureWorkspace(ws, fs);
  const status: ProposalStatus = input.status ?? 'proposed';
  if (!PROPOSAL_STATUS.includes(status)) {
    throw new WikiError('BAD_STATUS', `unknown status ${JSON.stringify(status)}`, `one of: ${PROPOSAL_STATUS.join(', ')}`);
  }
  const path = joinPath(ws.wiki, FILES.impact);
  const text = await fs.readFile(path);
  const lines = text.split(/\r?\n/);
  const rows = lines.map((line, index) => ({ line, index, cells: line.trim().startsWith('|') ? splitRow(line) : [] }));

  if (input.id !== undefined) {
    // Resolving an existing proposal only needs its id, the new status and an outcome.
    const hit = rows.find((row) => row.cells[0] === input.id);
    if (hit === undefined) {
      throw new WikiError('PROPOSAL_MISSING', `no proposal ${input.id}`, 'omit id to record a new proposal');
    }
    const cells = hit.cells;
    while (cells.length < 8) {
      cells.push('');
    }
    if (input.score !== undefined) {
      cells[5] = cell(input.score);
    }
    cells[6] = status;
    if (input.outcome !== undefined) {
      cells[7] = cell(input.outcome);
    }
    lines[hit.index] = `| ${cells.join(' | ')} |`;
    await fs.writeFile(path, lines.join('\n'));
    return { id: input.id, status, file: FILES.impact };
  }

  if (input.target.trim() === '' || input.change.trim() === '') {
    throw new WikiError('BAD_PROPOSAL', 'a proposal needs a target skill file and the change it makes', 'e.g. target "skills/decx-vulnhunt/SKILL.md"');
  }
  const target = normalizeRel(input.target);
  const skillName = /^skills\/([^/]+)\//.exec(`${target}/`)?.[1];
  const file = target.split('/').at(-1) ?? '';
  if (skillName !== undefined && (file === '' || !file.includes('.'))) {
    throw new WikiError('BAD_PROPOSAL', `a proposal changes one file inside one skill, not the path ${JSON.stringify(input.target)}`, 'name the file the change lands in, e.g. "skills/decx-vulnhunt/SKILL.md"');
  }
  if (skillName === undefined) {
    throw new WikiError('BAD_PROPOSAL', `a proposal changes one file inside one skill, not ${JSON.stringify(input.target)}`, 'targets look like "skills/decx-vulnhunt/SKILL.md" or "skills/decx-vulnhunt/references/patterns/android-app-uri_grant.md"');
  }
  if (!(await fs.exists(joinPath(ws.skills, skillName, 'SKILL.md')))) {
    throw new WikiError('UNKNOWN_SKILL', `no skill ${skillName} in ${ws.name}`, 'the target skill directory must contain a SKILL.md');
  }

  const stamp = now.toISOString().slice(0, 10).replaceAll('-', '');
  const used = rows.filter((row) => row.cells[0]?.startsWith(`p-${stamp}-`)).length;
  const id = `p-${stamp}-${used + 1}`;
  const row = `| ${id} | ${now.toISOString().slice(0, 10)} | ${cell(input.target)} | ${cell(input.change)} | ${cell(input.evidence ?? '')} | ${cell(input.score ?? '')} | ${status} | ${cell(input.outcome ?? '')} |`;
  await fs.writeFile(path, `${text.replace(/\s*$/, '')}\n${row}\n`);
  return { id, status, file: FILES.impact };
}

/* ------------------------------------------------------------------ lint */

export async function lintWorkspace(ws: Workspace, fs: WikiFs): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  for (const name of [FILES.index, FILES.logs, FILES.impact]) {
    if (!(await fs.exists(joinPath(ws.wiki, name)))) {
      findings.push({ level: 'error', area: 'wiki', file: name, message: `missing ${name} — run decx_maintain with resync_index to create the workspace files` });
    }
  }
  const pages = await patternPages(ws, fs);
  const seen = new Map<string, string>();
  for (const { name, page } of pages) {
    const file = `${FILES.patterns}/${name}.md`;
    if (page.name === '') {
      findings.push({ level: 'error', area: 'wiki', file, message: 'frontmatter is missing "name"' });
    } else if (page.track !== '' && name !== page.name && name !== `${page.track}-${page.name}`) {
      findings.push({ level: 'warn', area: 'wiki', file, message: `file name "${name}" does not follow "<track>-<name>" (${page.track}-${page.name})` });
    }
    if (page.track === '') {
      findings.push({ level: 'error', area: 'wiki', file, message: 'frontmatter is missing "track"' });
    }
    for (const section of PATTERN_SECTIONS) {
      if ((page.sections[section] ?? '') === '') {
        findings.push({ level: 'error', area: 'wiki', file, message: `missing "## ${section}" section` });
      }
    }
    if (page.track !== '' && !TRACK_ORDER.includes(page.track)) {
      findings.push({ level: 'warn', area: 'wiki', file, message: `unknown track "${page.track}" — use one of ${TRACK_ORDER.join(' | ')}` });
    }
    const match = page.sections['Match'] ?? '';
    if (match !== '' && firstSentence(match).endsWith('…')) {
      findings.push({
        level: 'warn',
        area: 'wiki',
        file,
        message: 'the "## Match" opener is longer than 140 characters — it becomes the index trigger, so open with one short line',
      });
    }
    const identity = `${page.track}-${page.name}`;
    const previous = seen.get(identity);
    if (previous !== undefined && previous !== name) {
      findings.push({ level: 'error', area: 'wiki', file, message: `pattern "${identity}" is already used by ${previous}.md` });
    }
    seen.set(identity, name);
    findings.push(
      ...(await linkFindings(fs, 'wiki', file, await fs.readFile(joinPath(ws.wiki, FILES.patterns, `${name}.md`)), [
        joinPath(ws.wiki, FILES.patterns),
        ws.wiki,
        ws.root,
        ws.skills,
      ])),
    );
  }

  if (await fs.exists(joinPath(ws.wiki, FILES.index))) {
    const index = await fs.readFile(joinPath(ws.wiki, FILES.index));
    const listed = indexRows(index);
    for (const { name } of pages) {
      if (!listed.includes(name)) {
        findings.push({ level: 'error', area: 'wiki', file: FILES.index, message: `no row for pattern ${name}` });
      }
    }
    for (const name of listed) {
      if (!pages.some(({ name: page }) => page === name)) {
        findings.push({ level: 'error', area: 'wiki', file: FILES.index, message: `row for ${name} has no page in ${FILES.patterns}/` });
      }
    }
    for (const { name, page } of pages) {
      if (listed.includes(name) && !index.includes(indexRow(name, page))) {
        findings.push({ level: 'error', area: 'wiki', file: FILES.index, message: `row for ${name} no longer matches its page: run decx_maintain with resync_index` });
      }
    }
  }

  if (await fs.exists(joinPath(ws.wiki, FILES.impact))) {
    const impact = await fs.readFile(joinPath(ws.wiki, FILES.impact));
    if (!impact.includes(IMPACT_SCHEMA)) {
      findings.push({ level: 'error', area: 'wiki', file: FILES.impact, message: 'the ledger header does not match the schema the extension appends to' });
    }
    for (const line of impact.split(/\r?\n/)) {
      if (!line.trim().startsWith('|')) {
        continue;
      }
      const cells = splitRow(line);
      if (cells[0] === 'id' || cells[0].startsWith('---')) {
        continue;
      }
      if (cells.length !== IMPACT_COLUMNS) {
        findings.push({ level: 'error', area: 'wiki', file: FILES.impact, message: `ledger row ${JSON.stringify(cells[0] ?? '')} has ${cells.length} cells, expected ${IMPACT_COLUMNS}` });
      }
    }
  }

  for (const dir of await skillDirs(ws, fs)) {
    const skill = joinPath(ws.skills, dir);
    const files = ['SKILL.md', 'PURPOSE.md'];
    for (const name of await listFiles(fs, joinPath(skill, 'references'))) {
      files.push(`references/${name}`);
    }
    for (const name of await listFiles(fs, joinPath(skill, 'references', 'patterns'))) {
      files.push(`references/patterns/${name}`);
    }
    if (!(await fs.exists(joinPath(skill, 'PURPOSE.md')))) {
      findings.push({ level: 'warn', area: 'skill', file: `skills/${dir}/PURPOSE.md`, message: 'no PURPOSE.md: the maintenance mapping that ties the skill to its patterns' });
    }
    for (const file of files) {
      const full = joinPath(skill, file);
      if (!(await fs.exists(full))) {
        continue;
      }
      const base = file.includes('/') ? joinPath(skill, file.slice(0, file.lastIndexOf('/'))) : skill;
      findings.push(...(await linkFindings(fs, 'skill', `skills/${dir}/${file}`, await fs.readFile(full), [base, joinPath(skill, 'references'), skill, ws.root, ws.wiki])));
    }
  }
  return findings;
}

/**
 * Markdown links and `[[wiki links]]` must resolve.  Google-style wikilinks are
 * resolved against the file's own directory first, then the wiki root and the
 * skill root, so a pattern page can write `[[app_uri-grant]]` while a reference
 * file writes `[[wiki/patterns/android-app-uri_grant]]`.
 */
async function linkFindings(fs: WikiFs, area: 'wiki' | 'skill', file: string, text: string, bases: string[]): Promise<LintFinding[]> {
  const findings: LintFinding[] = [];
  const exists = async (candidates: string[]): Promise<boolean> => {
    for (const candidate of candidates) {
      if (await fs.exists(candidate)) {
        return true;
      }
    }
    return false;
  };
  const resolve = (target: string): string[] => bases.flatMap((base) => [joinPath(base, target), joinPath(base, `${target}.md`)]);
  for (const match of text.matchAll(/\]\((?!https?:|mailto:|#)([^)\s]+)\)/g)) {
    const target = match[1].split('#')[0];
    if (target === '' || target.startsWith('/')) {
      continue;
    }
    if (!(await exists(resolve(target)))) {
      findings.push({ level: 'error', area, file, message: `link target does not exist: ${target}` });
    }
  }
  for (const match of text.matchAll(/\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/g)) {
    const target = match[1].trim();
    if (target === '' || target.startsWith('/') || target.includes('://')) {
      continue;
    }
    if (!(await exists([...resolve(target), ...bases.map((base) => joinPath(base, target, 'SKILL.md'))]))) {
      findings.push({ level: 'error', area, file, message: `wikilink target does not exist: ${target}` });
    }
  }
  return findings;
}

/* ---------------------------------------------------------------- status */

export async function status(ws: Workspace, fs: WikiFs): Promise<WorkspaceStatus> {
  const pages = await patternPages(ws, fs);
  const index = (await fs.exists(joinPath(ws.wiki, FILES.index))) ? await fs.readFile(joinPath(ws.wiki, FILES.index)) : '';
  const listed = indexRows(index);
  const impact = (await fs.exists(joinPath(ws.wiki, FILES.impact))) ? await fs.readFile(joinPath(ws.wiki, FILES.impact)) : '';
  const openProposals = impact
    .split(/\r?\n/)
    .filter((line) => line.trim().startsWith('|'))
    .map((line) => splitRow(line))
    .filter((cells) => cells[6] === 'proposed').length;
  const logLines = (await fs.exists(joinPath(ws.wiki, FILES.logs))) ? (await fs.readFile(joinPath(ws.wiki, FILES.logs))).split(/\r?\n/).filter((line) => line.startsWith('- ')) : [];
  const out: WorkspaceStatus = {
    name: ws.name,
    root: ws.root,
    skills: await skillDirs(ws, fs),
    patterns: pages.length,
    indexRows: listed.length,
    missingRows: pages.map(({ name }) => name).filter((name) => !listed.includes(name)),
    staleRows: listed.filter((name) => !pages.some(({ name: page }) => page === name)),
    traces: (await traceFiles(ws, fs)).length,
    openProposals,
    findings: await lintWorkspace(ws, fs),
  };
  const last = logLines.at(-1);
  if (last !== undefined) {
    out.lastLog = last;
  }
  return out;
}

export function describeStatus(state: WorkspaceStatus): string {
  const problems = state.findings.filter((finding) => finding.level === 'error').length;
  const warnings = state.findings.length - problems;
  const freshness = state.missingRows.length + state.staleRows.length === 0 ? 'index in sync' : `index out of sync (${state.missingRows.length} missing, ${state.staleRows.length} stale)`;
  const scope = state.skills.length === 0 ? 'no skills' : `${state.skills.length} skill(s)`;
  return `${state.name}: ${state.patterns} patterns, ${scope}, ${state.traces} traces, ${state.openProposals} open proposals, ${freshness}, ${problems} error(s)/${warnings} warning(s)`;
}

export function describeFinding(finding: LintFinding): string {
  return `${finding.level} ${finding.area}/${finding.file}: ${finding.message}`;
}

/* ------------------------------------------------------------ checkpoints */

/**
 * Session checkpoints: a per-session ledger, counted by rounds or turns.  It is
 * session state, not skill knowledge, so it lives outside the wiki and survives
 * compaction and `/reload`.
 */
export const CHECKPOINT_UNITS = ['round', 'turn'] as const;
export type CheckpointUnit = (typeof CHECKPOINT_UNITS)[number];
/** How many checkpoints the ledger keeps; older ones are dropped. */
export const CHECKPOINT_KEEP = 10;

export interface Checkpoint {
  n: number;
  round: number;
  turn: number;
  at: string;
  goal: string;
  facts: string[];
  steps: string[];
  decisions: string[];
  next: string;
}

export interface SessionState {
  session: string;
  rounds: number;
  turns: number;
  taken: number;
  checkpoints: Checkpoint[];
}

export interface CheckpointInput {
  goal: string;
  facts: string[];
  steps: string[];
  next: string;
  decisions?: string[];
}

export function emptySessionState(session: string): SessionState {
  return { session, rounds: 0, turns: 0, taken: 0, checkpoints: [] };
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && item.trim() !== '') : [];
}

/** Tolerant read: a truncated or hand-edited ledger must not break a session. */
export function parseSessionState(session: string, text: string): SessionState {
  const raw = JSON.parse(text) as { rounds?: unknown; turns?: unknown; taken?: unknown; checkpoints?: unknown };
  const counter = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : 0);
  const checkpoints: Checkpoint[] = [];
  for (const item of Array.isArray(raw.checkpoints) ? raw.checkpoints : []) {
    const candidate = item as Partial<Checkpoint> | null;
    if (candidate === null || typeof candidate !== 'object' || typeof candidate.goal !== 'string' || typeof candidate.next !== 'string') {
      continue;
    }
    checkpoints.push({
      n: counter(candidate.n),
      round: counter(candidate.round),
      turn: counter(candidate.turn),
      at: typeof candidate.at === 'string' ? candidate.at : '',
      goal: candidate.goal,
      facts: stringList(candidate.facts),
      steps: stringList(candidate.steps),
      decisions: stringList(candidate.decisions),
      next: candidate.next,
    });
  }
  return { session, rounds: counter(raw.rounds), turns: counter(raw.turns), taken: counter(raw.taken), checkpoints };
}

export function serializeSessionState(state: SessionState): string {
  return `${JSON.stringify(state, null, 2)}\n`;
}

/** Session ids are UUIDs, but the ledger file name is sanitized anyway. */
export function stateFileName(session: string): string {
  const safe = session.replaceAll(/[^a-zA-Z0-9._-]/g, '_');
  return `${safe === '' ? 'session' : safe}.json`;
}

export async function readSessionState(dir: string, session: string, fs: WikiFs): Promise<SessionState> {
  const path = joinPath(dir, stateFileName(session));
  if (!(await fs.exists(path))) {
    return emptySessionState(session);
  }
  try {
    return parseSessionState(session, await fs.readFile(path));
  } catch {
    return emptySessionState(session);
  }
}

export async function writeSessionState(dir: string, state: SessionState, fs: WikiFs): Promise<void> {
  await fs.mkdirp(dir);
  await fs.writeFile(joinPath(dir, stateFileName(state.session)), serializeSessionState(state));
}

/** Appends the checkpoint to the ledger and drops the oldest entries. */
export function recordCheckpoint(state: SessionState, input: CheckpointInput, now: Date): Checkpoint {
  state.taken += 1;
  const checkpoint: Checkpoint = {
    n: state.taken,
    round: state.rounds,
    turn: state.turns,
    at: now.toISOString(),
    goal: input.goal.trim(),
    facts: stringList(input.facts),
    steps: stringList(input.steps),
    decisions: stringList(input.decisions ?? []),
    next: input.next.trim(),
  };
  state.checkpoints.push(checkpoint);
  if (state.checkpoints.length > CHECKPOINT_KEEP) {
    state.checkpoints = state.checkpoints.slice(-CHECKPOINT_KEEP);
  }
  return checkpoint;
}

/** The counter a checkpoint is measured against. */
export function checkpointCount(state: SessionState, unit: CheckpointUnit): number {
  return unit === 'round' ? state.rounds : state.turns;
}

/** Highest counter value any checkpoint in the ledger recorded. */
export function checkpointCovered(state: SessionState, unit: CheckpointUnit): number {
  return state.checkpoints.reduce((max, checkpoint) => Math.max(max, unit === 'round' ? checkpoint.round : checkpoint.turn), 0);
}

/**
 * The counter value that still needs a checkpoint, or `undefined` when the
 * ledger covers it.  A missed checkpoint keeps pointing at the multiple it was
 * due at, so the reminder repeats instead of being dropped.
 */
export function checkpointDue(state: SessionState, every: number, unit: CheckpointUnit): number | undefined {
  if (!Number.isInteger(every) || every <= 0) {
    return undefined;
  }
  const count = checkpointCount(state, unit);
  if (count === 0) {
    return undefined;
  }
  const multiple = Math.floor(count / every) * every;
  return multiple > checkpointCovered(state, unit) ? multiple : undefined;
}

export function lastCheckpoint(state: SessionState): Checkpoint | undefined {
  return state.checkpoints.at(-1);
}

/** One line, for the system prompt: keeps the goal alive across a compaction. */
export function describeCheckpoint(checkpoint: Checkpoint, limit = 200): string {
  const shorten = (text: string): string => (text.length <= limit ? text : `${text.slice(0, limit - 1)}…`);
  return `checkpoint #${checkpoint.n} (round ${checkpoint.round}, turn ${checkpoint.turn}): goal ${shorten(checkpoint.goal)}; next ${shorten(checkpoint.next)}`;
}

/** The steering message: what a checkpoint must contain, and why it is asked for. */
export function checkpointDirective(state: SessionState, due: number, every: number, unit: CheckpointUnit): string {
  const previous = lastCheckpoint(state);
  const lines = [`Decx checkpoint due: ${due} ${unit}${due === 1 ? '' : 's'}, every ${every}${previous === undefined ? '' : `, the previous one was #${previous.n}`}.`, ''];
  if (previous !== undefined) {
    lines.push(`Previous — ${describeCheckpoint(previous)}`, '');
  }
  lines.push(
    'Before doing more work, write a checkpoint in your reply and record it with the decx_checkpoint tool (goal, facts, steps, next).',
    '',
    'Then look for drift: work that no longer serves the goal, facts you only assumed, steps you are repeating. State it and correct course before continuing.',
  );
  return lines.join('\n');
}

/** The checkpoint as markdown, echoed back so the agent sees what was stored. */
export function checkpointBlock(checkpoint: Checkpoint): string {
  const bullet = (label: string, items: string[]): string[] => (items.length === 0 ? [] : [`- ${label}: ${items.join('; ')}`]);
  return [
    `# checkpoint #${checkpoint.n}`,
    '',
    `- round ${checkpoint.round} · turn ${checkpoint.turn} · ${checkpoint.at}`,
    `- goal: ${checkpoint.goal}`,
    ...bullet('facts', checkpoint.facts),
    ...bullet('steps', checkpoint.steps),
    ...bullet('decisions', checkpoint.decisions),
    `- next: ${checkpoint.next}`,
  ].join('\n');
}
