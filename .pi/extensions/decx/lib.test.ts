import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, before, describe, it } from 'node:test';
import {
  applyMaintain,
  CHECKPOINT_KEEP,
  checkpointBlock,
  checkpointDirective,
  checkpointDue,
  describeCheckpoint,
  discoverWorkspaces,
  emptySessionState,
  ensureWorkspace,
  initLocalWiki,
  firstSentence,
  indexRow,
  indexRows,
  isWikiError,
  lintWorkspace,
  normalizeRel,
  parsePattern,
  parseSessionState,
  readPage,
  readSessionState,
  recordCheckpoint,
  recordProposal,
  resyncIndex,
  serializeSessionState,
  stateFileName,
  status,
  workspaceAt,
  writeSessionState,
  writeTrace,
  type ProposalStatus,
  type Workspace,
} from './lib.ts';
import { nodeFs } from './node-fs.ts';

const roots: string[] = [];
const fs = nodeFs(() => roots.map((root) => ({ root })));

function page(name: string, track: string, match: string): string {
  return `---\nname: ${name}\ntrack: ${track}\n---\n\n# ${name}\n\n## Match\n${match}\n\n## Non-obvious\n- the subtle mechanism\n\n## Reject\nnot reportable on its own\n`;
}

/** Asserts the promise rejects with a `WikiError` carrying this code. */
function throwsCode(code: string): (error: unknown) => boolean {
  return (error: unknown): boolean => {
    assert.ok(isWikiError(error), `expected WikiError, got ${String(error)}`);
    assert.equal(error.code, code);
    return true;
  };
}

async function fixture(): Promise<Workspace> {
  const root = await mkdtemp(join(tmpdir(), 'decx-'));
  roots.push(root);
  const skill = join(root, 'skills', 'demo');
  await mkdir(skill, { recursive: true });
  await mkdir(join(root, 'wiki', 'patterns'), { recursive: true });
  await mkdir(join(root, 'raw'), { recursive: true });
  await writeFile(join(skill, 'SKILL.md'), '# demo\n\nRun the checks this skill defines; the wiki is maintenance material.\n');
  await writeFile(join(skill, 'PURPOSE.md'), '# purpose\n\nMaintained from [[patterns/alpha]]: this skill exists because of that pattern.\n');
  await writeFile(join(root, 'wiki', 'patterns', 'alpha.md'), page('alpha', 'android-app', 'Alpha trigger fires when x is exported.'));
  return workspaceAt('demo', root);
}

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

describe('paths and parsing', () => {
  it('normalizes relative paths and rejects escapes', () => {
    assert.equal(normalizeRel('./patterns/a.md'), 'patterns/a.md');
    assert.equal(normalizeRel('patterns//a.md'), 'patterns/a.md');
    for (const bad of ['', '/etc/passwd', '../x.md', 'patterns/../../x.md', 'C:\\x']) {
      assert.throws(() => normalizeRel(bad), (error: unknown) => isWikiError(error) && error.code === 'BAD_PATH');
    }
  });

  it('parses frontmatter, sections and the index row', () => {
    const parsed = parsePattern(page('alpha', 'android-app', 'Trigger happens here.'));
    assert.equal(parsed.name, 'alpha');
    assert.equal(parsed.track, 'android-app');
    assert.deepEqual(Object.keys(parsed.sections), ['Match', 'Non-obvious', 'Reject']);
    assert.equal(indexRow('android-app-alpha', parsed), '- `android-app-alpha` — Trigger happens here.');
    assert.equal(firstSentence('a'.repeat(200)), `${'a'.repeat(140)}…`);
    assert.equal(indexRows(`${indexRow('android-app-alpha', parsed)}\nnot a row`)[0], 'android-app-alpha');
  });
});

describe('workspaces', () => {
  it('discovers only an initialized local wiki, never archived root layers', async () => {
    const archived = await fixture();
    assert.deepEqual(await discoverWorkspaces(archived.root, fs), []);
    const local = await initLocalWiki(archived.root, fs);
    const found = await discoverWorkspaces(archived.root, fs);
    assert.equal(found.length, 1);
    assert.equal(found[0].root, local.workspace.root);
    assert.equal(found[0].skills, join(archived.root, '.agents', 'skills').replaceAll('\\', '/'));
    assert.notEqual(found[0].skills, archived.skills);
  });

  it('initializes .decxwiki in an empty project and preserves existing pages', async () => {
    const project = await mkdtemp(join(tmpdir(), 'decx-project-'));
    roots.push(project);
    assert.deepEqual(await discoverWorkspaces(project, fs), []);
    const first = await initLocalWiki(project, fs);
    assert.equal(first.workspace.root, join(project, '.decxwiki').replaceAll('\\', '/'));
    assert.deepEqual(first.created, ['index.md', 'logs.md', 'skill-impact.md']);
    assert.equal(await readFile(join(project, '.decxwiki', '.gitignore'), 'utf8'), '/raw/\n');
    assert.deepEqual(await fs.listDir(join(project, '.agents', 'skills')), []);
    assert.equal((await discoverWorkspaces(project, fs))[0].root, first.workspace.root);
    const index = join(first.workspace.wiki, 'index.md');
    await writeFile(index, 'my index\n');
    assert.deepEqual((await initLocalWiki(project, fs)).created, []);
    assert.equal(await readFile(index, 'utf8'), 'my index\n');
    assert.equal((await status(first.workspace, fs)).patterns, 0);
  });

  it('preserves a skill installed by an external skill manager', async () => {
    const project = await mkdtemp(join(tmpdir(), 'decx-existing-skill-'));
    roots.push(project);
    const installed = join(project, '.agents', 'skills', 'decx-tool', 'SKILL.md');
    await mkdir(join(project, '.agents', 'skills', 'decx-tool'), { recursive: true });
    await writeFile(installed, '# locally installed\n');
    await initLocalWiki(project, fs);
    await initLocalWiki(project, fs);
    assert.equal(await fs.readFile(installed), '# locally installed\n');
    assert.deepEqual(await fs.listDir(join(project, '.agents', 'skills')), ['decx-tool']);
  });

  it('can initialize a project below an unrelated ancestor named raw', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'decx-ancestor-'));
    roots.push(parent);
    const project = join(parent, 'raw', 'project');
    await mkdir(project, { recursive: true });
    const { workspace } = await initLocalWiki(project, fs);
    assert.match(await readFile(join(workspace.wiki, 'index.md'), 'utf8'), /decx:index:start/);
  });

  it('does not treat an unrelated root wiki or skills directory as a workspace', async () => {
    const workspace = await fixture();
    assert.deepEqual(await discoverWorkspaces(workspace.root, fs), []);
    const local = await initLocalWiki(workspace.root, fs);
    assert.equal((await discoverWorkspaces(workspace.root, fs))[0].root, local.workspace.root);
  });

  it('rejects a symlinked .decxwiki instead of following it', async () => {
    const project = await mkdtemp(join(tmpdir(), 'decx-project-'));
    const outside = await mkdtemp(join(tmpdir(), 'decx-outside-'));
    roots.push(project, outside);
    const { symlink } = await import('node:fs/promises');
    await symlink(outside, join(project, '.decxwiki'), process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(initLocalWiki(project, fs), throwsCode('UNSAFE_PATH'));
    assert.deepEqual(await import('node:fs/promises').then(({ readdir }) => readdir(outside)), []);
  });

  it('seeds the workspace files once', async () => {
    const workspace = await fixture();
    const created = await ensureWorkspace(workspace, fs);
    assert.deepEqual(created, ['index.md', 'logs.md', 'skill-impact.md']);
    assert.deepEqual(await ensureWorkspace(workspace, fs), []);
    assert.match(await readFile(join(workspace.wiki, 'logs.md'), 'utf8'), /# maintenance log — demo/);
  });

  it('reads pages, refuses escapes and lists what exists', async () => {
    const workspace = await fixture();
    await ensureWorkspace(workspace, fs);
    const read = await readPage(workspace, 'patterns/alpha.md', fs);
    assert.match(read.text, /Alpha trigger/);
    await assert.rejects(readPage(workspace, '../skills/demo/SKILL.md', fs), throwsCode('BAD_PATH'));
    await assert.rejects(readPage(workspace, 'patterns/missing.md', fs), (error: unknown) => {
      assert.ok(isWikiError(error));
      assert.equal(error.code, 'NOT_FOUND');
      assert.match(error.hint ?? '', /patterns\/alpha\.md/);
      return true;
    });
  });
});

describe('traces', () => {
  it('appends immutable raw traces with unique ids', async () => {
    const workspace = await fixture();
    const first = await writeTrace(workspace, { summary: 'Provider leak on Foo', body: 'ran abc', files: ['foo.apk'], outcome: 'confirmed' }, fs, new Date('2026-09-15T08:00:00Z'));
    assert.equal(first.path, 'raw/traces/20260915-080000-provider-leak-on-foo.md');
    // The paper's read alias: traces/<id>.md resolves into the raw layer.
    const trace = await readPage(workspace, `traces/${first.id}.md`, fs);
    assert.match(trace.text, new RegExp(first.id));
    const text = await readFile(join(workspace.root, first.path), 'utf8');
    assert.match(text, /^---\nid: 20260915-080000-provider-leak-on-foo\n/);
    assert.match(text, /files: foo\.apk/);
    assert.match(text, /outcome: confirmed/);
    const second = await writeTrace(workspace, { summary: 'Provider leak on Foo', body: 'ran def' }, fs, new Date('2026-09-15T08:00:00Z'));
    assert.equal(second.path, 'raw/traces/20260915-080000-provider-leak-on-foo-2.md');
    await assert.rejects(writeTrace(workspace, { summary: 'x', body: '  ' }, fs), throwsCode('BAD_TRACE'));
  });
});

describe('index', () => {
  it('does not erase the index when listing patterns fails', async () => {
    const workspace = await fixture();
    await resyncIndex(workspace, fs);
    const path = join(workspace.wiki, 'index.md');
    const before = await readFile(path, 'utf8');
    const denied = Object.assign(new Error('access denied'), { code: 'EACCES' });
    await assert.rejects(resyncIndex(workspace, {
      ...fs,
      listDir: async (dir) => {
        if (join(dir) === join(workspace.wiki, 'patterns')) throw denied;
        return fs.listDir(dir);
      },
    }), (error: unknown) => error === denied);
    assert.equal(await readFile(path, 'utf8'), before);
  });

  it('resyncs the managed block and reports the delta', async () => {
    const workspace = await fixture();
    const first = await resyncIndex(workspace, fs);
    assert.deepEqual(first, { added: ['alpha'], removed: [], total: 1 });
    const index = await readFile(join(workspace.wiki, 'index.md'), 'utf8');
    assert.match(index, /patterns: 1/);
    assert.match(index, /### Android app \(1\)\n- `alpha` — Alpha trigger fires when x is exported\./);
    await writeFile(join(workspace.wiki, 'patterns', 'beta.md'), page('beta', 'android-framework', 'Beta trigger.'));
    await rm(join(workspace.wiki, 'patterns', 'alpha.md'));
    const second = await resyncIndex(workspace, fs);
    assert.deepEqual(second, { added: ['beta'], removed: ['alpha'], total: 1 });
    const state = await status(workspace, fs);
    assert.equal(state.patterns, 1);
    assert.deepEqual(state.missingRows, []);
    assert.deepEqual(state.staleRows, []);
    assert.match(await readFile(join(workspace.wiki, 'logs.md'), 'utf8'), /maintenance log/);
  });
});

describe('maintain', () => {
  async function seeded(): Promise<Workspace> {
    const workspace = await fixture();
    await applyMaintain(workspace, { summary: 'seed', resync_index: true }, fs, new Date('2026-09-15T08:00:00Z'));
    return workspace;
  }

  it('creates a pattern and requires an index update', async () => {
    const workspace = await seeded();
    await assert.rejects(applyMaintain(workspace, { summary: 'no index' }, fs), throwsCode('INDEX_REQUIRED'));
    const created = await applyMaintain(workspace, { summary: 'add beta', create_patterns: [{ name: 'beta', content: page('beta', 'android-framework', 'Beta trigger.') }], resync_index: true }, fs, new Date('2026-09-15T09:00:00Z'));
    assert.deepEqual(created.created, ['beta']);
    assert.equal(created.indexRows, 2);
    // No log: a maintenance pass leaves the seeded log (and the ledger) untouched.
    assert.equal(await readFile(join(workspace.wiki, 'logs.md'), 'utf8'), '# maintenance log — demo\n');
  });

  it('appends a log entry only when log is asked for, and never adds a ledger row', async () => {
    const workspace = await fixture();
    await applyMaintain(workspace, { summary: 'add beta', log: true, create_patterns: [{ name: 'beta', content: page('beta', 'android-framework', 'Beta trigger.') }], resync_index: true }, fs, new Date('2026-09-15T09:00:00Z'));
    assert.match(await readFile(join(workspace.wiki, 'logs.md'), 'utf8'), /2026-09-15T09:00:00\.000Z maintain: add beta — created beta; index resynced/);
    assert.doesNotMatch(await readFile(join(workspace.wiki, 'skill-impact.md'), 'utf8'), /p-\d{8}-\d/);
  });

  it('validates names, content and edits', async () => {
    const workspace = await seeded();
    await assert.rejects(applyMaintain(workspace, { summary: 'bad name', create_patterns: [{ name: 'Bad Name', content: page('Bad Name', 'android-app', 'x') }], resync_index: true }, fs), throwsCode('BAD_PATTERN_NAME'));
    await assert.rejects(applyMaintain(workspace, { summary: 'thin', create_patterns: [{ name: 'thin', content: '# thin\n' }], resync_index: true }, fs), throwsCode('INVALID_PATTERN'));
    await assert.rejects(applyMaintain(workspace, { summary: 'dup', create_patterns: [{ name: 'alpha', content: page('alpha', 'android-app', 'x') }], resync_index: true }, fs), throwsCode('PATTERN_EXISTS'));
    await assert.rejects(applyMaintain(workspace, { summary: 'miss', update_patterns: [{ name: 'alpha', edits: [{ op: 'replace', target: 'not there', content: 'x' }] }], resync_index: true }, fs), throwsCode('EDIT_TARGET_MISSING'));
    await assert.rejects(applyMaintain(workspace, { summary: 'ambiguous', update_patterns: [{ name: 'alpha', edits: [{ op: 'replace', target: 'alpha', content: 'x' }] }], resync_index: true }, fs), throwsCode('EDIT_TARGET_AMBIGUOUS'));
    await assert.rejects(applyMaintain(workspace, { summary: 'ghost', update_patterns: [{ name: 'ghost', edits: [{ op: 'append', content: 'x' }] }], resync_index: true }, fs), throwsCode('PATTERN_MISSING'));
  });

  it('edits a page with exact targets and accepts a matching index', async () => {
    const workspace = await seeded();
    const result = await applyMaintain(
      workspace,
      {
        summary: 'sharpen alpha',
        update_patterns: [{ name: 'alpha', edits: [{ op: 'replace', target: '- the subtle mechanism', content: '- only reachable when the caller sets the flag' }, { op: 'append', content: '\n## Evidence\nraw/traces/20260915-080000-provider-leak-on-foo.md' }] }],
        update_index: ['---', 'decx: demo', 'patterns: 1', '---', '', '<!-- decx:index:start -->', '- `alpha` — Alpha trigger fires when x is exported.', '<!-- decx:index:end -->', ''].join('\n'),
      },
      fs,
    );
    assert.deepEqual(result.updated, ['alpha']);
    const text = await readFile(join(workspace.wiki, 'patterns', 'alpha.md'), 'utf8');
    assert.match(text, /only reachable when the caller sets the flag/);
    assert.match(text, /## Evidence/);
  });

  it('rejects an index that misses a page', async () => {
    const workspace = await seeded();
    await assert.rejects(
      applyMaintain(workspace, { summary: 'stale index', update_index: '<!-- decx:index:start -->\n<!-- decx:index:end -->\n' }, fs),
      (error: unknown) => {
        assert.ok(isWikiError(error));
        assert.equal(error.code, 'INDEX_MISMATCH');
        assert.match(error.message, /missing rows: alpha/);
        return true;
      },
    );
  });
});

describe('skill impact ledger', () => {
  it('records proposals and resolves them', async () => {
    const workspace = await fixture();
    const first = await recordProposal(workspace, { target: 'skills/demo/SKILL.md', change: 'add a gate', evidence: 'alpha' }, fs, new Date('2026-09-15T08:00:00Z'));
    assert.deepEqual(first, { id: 'p-20260915-1', status: 'proposed', file: 'skill-impact.md' });
    const second = await recordProposal(workspace, { target: 'skills/demo/references/x.md', change: 'tighten wording', score: '0.61 > 0.52' }, fs, new Date('2026-09-15T09:00:00Z'));
    assert.equal(second.id, 'p-20260915-2');
    const resolved = await recordProposal(workspace, { id: second.id, target: 'ignored', change: 'ignored', status: 'accepted', outcome: 'reviewer approved' }, fs);
    assert.equal(resolved.status, 'accepted');
    const ledger = await readFile(join(workspace.wiki, 'skill-impact.md'), 'utf8');
    assert.match(ledger, /\| p-20260915-2 \| 2026-09-15 \| skills\/demo\/references\/x\.md \| tighten wording \| {2}\| 0\.61 > 0\.52 \| accepted \| reviewer approved \|/);
    await assert.rejects(recordProposal(workspace, { target: 'x', change: 'y', status: 'maybe' as ProposalStatus }, fs), throwsCode('BAD_STATUS'));
    await assert.rejects(recordProposal(workspace, { target: 'x', change: 'y', id: 'p-20260915-9' }, fs), throwsCode('PROPOSAL_MISSING'));
    await assert.rejects(recordProposal(workspace, { target: 'wiki/index.md', change: 'y' }, fs), throwsCode('BAD_PROPOSAL'));
    await assert.rejects(recordProposal(workspace, { target: 'skills/ghost/SKILL.md', change: 'y' }, fs), throwsCode('UNKNOWN_SKILL'));
    // A proposal changes one file, never a directory.
    await assert.rejects(recordProposal(workspace, { target: 'skills/demo', change: 'y' }, fs), throwsCode('BAD_PROPOSAL'));
    await assert.rejects(recordProposal(workspace, { target: 'skills/demo/references/', change: 'y' }, fs), throwsCode('BAD_PROPOSAL'));
  });
});

describe('lint and status', () => {
  it('passes a healthy workspace and reports a summary', async () => {
    const workspace = await fixture();
    await applyMaintain(workspace, { summary: 'seed', resync_index: true }, fs);
    const findings = await lintWorkspace(workspace, fs);
    assert.deepEqual(findings, []);
    const state = await status(workspace, fs);
    assert.equal(state.patterns, 1);
    assert.deepEqual(state.skills, ['demo']);
    assert.equal(state.indexRows, 1);
    assert.equal(state.openProposals, 0);
    assert.equal(state.traces, 0);
  });

  it('reports broken sections, index drift, duplicate names and dead links', async () => {
    const workspace = await fixture();
    await applyMaintain(workspace, { summary: 'seed', resync_index: true }, fs);
    await writeFile(join(workspace.wiki, 'patterns', 'alpha.md'), '---\nname: alpha\ntrack: android-app\n---\n\n# alpha\n\n## Match\nonly a match\n');
    await writeFile(join(workspace.wiki, 'patterns', 'android-app-alpha.md'), page('alpha', 'android-app', 'Duplicate name.'));
    await writeFile(join(workspace.wiki, 'patterns', 'linked.md'), page('linked', 'android-app', 'See [x](./missing.md).'));
    const skill = join(workspace.skills, 'demo');
    await mkdir(join(skill, 'references'), { recursive: true });
    await writeFile(join(skill, 'references', 'chains.md'), 'Good [[wiki/patterns/android-app-alpha]], broken [[wiki/patterns/ghost]]\n');
    await rm(join(skill, 'PURPOSE.md'));
    await resyncIndex(workspace, fs);
    const findings = await lintWorkspace(workspace, fs);
    const messages = findings.map((finding) => finding.message).join('\n');
    assert.match(messages, /missing "## Non-obvious" section/);
    assert.match(messages, /already used by/);
    assert.match(messages, /link target does not exist: \.\/missing\.md/);
    assert.match(messages, /wikilink target does not exist: wiki\/patterns\/ghost/);
    assert.match(messages, /no PURPOSE.md/);
    assert.ok(findings.some((finding) => finding.level === 'error'));
  });

  it('flags a hand-edited index row as drift', async () => {
    const workspace = await fixture();
    await applyMaintain(workspace, { summary: 'seed', resync_index: true }, fs);
    const path = join(workspace.wiki, 'index.md');
    const index = await readFile(path, 'utf8');
    await writeFile(path, index.replace(/Alpha trigger fires[^\n]*/, 'a stale summary'));
    const findings = await lintWorkspace(workspace, fs);
    assert.match(findings.map((finding) => finding.message).join('\n'), /row for alpha no longer matches its page/);
  });

  it('flags duplicate index rows and dead links inside the index', async () => {
    const workspace = await fixture();
    await applyMaintain(workspace, { summary: 'seed', resync_index: true }, fs);
    const path = join(workspace.wiki, 'index.md');
    const index = await readFile(path, 'utf8');
    await writeFile(path, `${index}\n- \`alpha\` — duplicated row\n\n[ghost](./patterns/ghost.md)\n`);
    const findings = await lintWorkspace(workspace, fs);
    const messages = findings.map((finding) => finding.message).join('\n');
    assert.match(messages, /row for alpha is listed more than once/);
    assert.match(messages, /link target does not exist: \.\/patterns\/ghost\.md/);
  });

  it('flags a ledger whose table no longer matches the schema', async () => {
    const workspace = await fixture();
    await recordProposal(workspace, { target: 'skills/demo/SKILL.md', change: 'add a gate' }, fs);
    const path = join(workspace.wiki, 'skill-impact.md');
    const text = await readFile(path, 'utf8');
    await writeFile(path, `${text.replace('| evidence | gate score | status |', '| evidence | status |')}| p-20260915-9 | 2026-09-15 | skills/demo/SKILL.md | y |\n`);
    const findings = await lintWorkspace(workspace, fs);
    const messages = findings.map((finding) => finding.message).join('\n');
    assert.match(messages, /ledger header does not match the schema/);
    assert.match(messages, /ledger row "p-20260915-9" has 4 cells, expected 8/);
  });

  it('errors when the workspace files are missing', async () => {
    const workspace = await fixture();
    const findings = await lintWorkspace(workspace, fs);
    assert.deepEqual(
      findings.map((finding) => finding.file).sort(),
      ['index.md', 'logs.md', 'skill-impact.md'],
    );
  });
});

describe('session checkpoints', () => {
  function input(goal: string): { goal: string; facts: string[]; steps: string[]; next: string } {
    return { goal, facts: [`fact for ${goal}`], steps: ['a step'], next: `next after ${goal}` };
  }

  it('records the counters of the moment and numbers the checkpoints', () => {
    const state = emptySessionState('s1');
    state.rounds = 3;
    state.turns = 9;
    const checkpoint = recordCheckpoint(state, input('ship the hook'), new Date('2026-09-15T10:00:00Z'));

    assert.equal(checkpoint.n, 1);
    assert.equal(checkpoint.round, 3);
    assert.equal(checkpoint.turn, 9);
    assert.equal(checkpoint.at, '2026-09-15T10:00:00.000Z');
    assert.equal(state.taken, 1);
    assert.deepEqual(checkpoint.facts, ['fact for ship the hook']);
  });

  it('keeps only the newest checkpoints and never reuses a number', () => {
    const state = emptySessionState('s1');
    for (let i = 1; i <= CHECKPOINT_KEEP + 3; i += 1) {
      state.rounds = i;
      recordCheckpoint(state, input(`goal ${i}`), new Date());
    }

    assert.equal(state.checkpoints.length, CHECKPOINT_KEEP);
    assert.equal(state.taken, CHECKPOINT_KEEP + 3);
    assert.equal(state.checkpoints.at(-1)?.n, CHECKPOINT_KEEP + 3);
    assert.equal(state.checkpoints[0]?.n, 4);
  });

  it('points at the uncovered multiple until a checkpoint covers it', () => {
    const state = emptySessionState('s1');
    state.rounds = 6;
    assert.equal(checkpointDue(state, 7, 'round'), undefined);

    state.rounds = 7;
    assert.equal(checkpointDue(state, 7, 'round'), 7);

    state.rounds = 8;
    assert.equal(checkpointDue(state, 7, 'round'), 7, 'a missed checkpoint keeps being due');

    recordCheckpoint(state, input('caught up at 8'), new Date());
    assert.equal(checkpointDue(state, 7, 'round'), undefined);

    state.rounds = 14;
    assert.equal(checkpointDue(state, 7, 'round'), 14);
    assert.equal(checkpointDue(state, 0, 'round'), undefined);
    assert.equal(checkpointDue(state, 1.5, 'round'), undefined);
  });

  it('measures rounds and turns independently', () => {
    const state = emptySessionState('s1');
    state.rounds = 7;
    state.turns = 2;

    assert.equal(checkpointDue(state, 7, 'round'), 7);
    assert.equal(checkpointDue(state, 7, 'turn'), undefined);

    recordCheckpoint(state, input('round 7'), new Date());
    state.turns = 7;
    assert.equal(checkpointDue(state, 7, 'round'), undefined);
    assert.equal(checkpointDue(state, 7, 'turn'), 7);
  });

  it('round-trips through the ledger file and survives a corrupt one', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'decx-state-'));
    roots.push(dir);
    const state = emptySessionState('sid-1');
    state.rounds = 7;
    state.turns = 21;
    recordCheckpoint(state, input('persist me'), new Date());
    await writeSessionState(dir, state, fs);

    const restored = await readSessionState(dir, 'sid-1', fs);
    assert.deepEqual(restored, state);
    assert.equal(await readSessionState(dir, 'other', fs).then((s) => s.checkpoints.length), 0);

    await writeFile(join(dir, stateFileName('sid-1')), '{"rounds": 3, "checkpoints": [{"goal":');
    const corrupt = await readSessionState(dir, 'sid-1', fs);
    assert.equal(corrupt.rounds, 0);
    assert.deepEqual(corrupt.checkpoints, []);
  });

  it('drops junk entries instead of failing the whole ledger', () => {
    const parsed = parseSessionState('sid', '{"rounds": 4, "taken": 2, "checkpoints": [{"goal": "keep", "next": "go"}, {"goal": 5}, "nonsense"]}');

    assert.equal(parsed.rounds, 4);
    assert.equal(parsed.taken, 2);
    assert.equal(parsed.checkpoints.length, 1);
    assert.equal(parsed.checkpoints[0]?.goal, 'keep');
    assert.deepEqual(parsed.checkpoints[0]?.facts, []);
    assert.ok(serializeSessionState(parsed).endsWith('\n'));
  });

  it('sanitizes the ledger file name', () => {
    assert.equal(stateFileName('9f1c-4a/../b c'), '9f1c-4a_.._b_c.json');
    assert.equal(stateFileName(''), 'session.json');
  });

  it('renders a directive that names the due point and the previous checkpoint', () => {
    const state = emptySessionState('sid');
    state.rounds = 14;
    const first = recordCheckpoint(state, input('goal one'), new Date());
    const directive = checkpointDirective(state, 14, 7, 'round');

    assert.match(directive, /checkpoint due: 14 rounds, every 7/);
    assert.match(directive, new RegExp(`Previous — checkpoint #${first.n}`));
    assert.match(directive, /decx_checkpoint tool/);
    assert.match(describeCheckpoint(first), /goal goal one; next next after goal one/);

    const block = checkpointBlock(first);
    assert.match(block, /# checkpoint #1/);
    assert.match(block, /- facts: fact for goal one/);
    assert.match(block, /- next: next after goal one/);
  });
});

// Behavioral regressions for the knowledge-layer API and evolution loop.
import { symlink } from 'node:fs/promises';
import { toolBlock } from './policy.ts';
import { candidatePath, gateCandidate, proposeCandidate } from './evolution.ts';

describe('knowledge access boundaries', () => {
  it('refuses arbitrary workspace files and update path traversal', async () => {
    const ws = await fixture();
    await writeFile(join(ws.root, '.env'), 'SECRET');
    await assert.rejects(readPage(ws, '.env', fs), throwsCode('BAD_PATH'));
    await assert.rejects(applyMaintain(ws, { update_patterns: [{ name: '../../raw/escape', edits: [] }], resync_index: true }, fs), throwsCode('BAD_PATTERN_NAME'));
  });

  it('rejects links out of managed layers', async () => {
    const ws = await fixture();
    await symlink(join(ws.root, 'skills/demo/SKILL.md'), join(ws.wiki, 'patterns/linked.md'));
    await assert.rejects(readPage(ws, 'patterns/linked.md', fs), throwsCode('UNSAFE_PATH'));
  });

  it('writes simultaneous traces without replacing evidence or seeding the wiki', async () => {
    const ws = await fixture();
    const traces = await Promise.all(Array.from({ length: 8 }, (_, n) => writeTrace(ws, { summary: 'same', body: `evidence ${n}` }, fs, new Date('2026-09-21T00:00:00Z'))));
    assert.equal(new Set(traces.map(t => t.id)).size, 8);
    for (const [n, trace] of traces.entries()) {
      const text = await fs.readFile(join(ws.root, trace.path));
      assert.ok(text.includes(`id: ${trace.id}\n`));
      assert.ok(text.includes(`evidence ${n}`));
    }
    assert.equal(await fs.exists(join(ws.wiki, 'skill-impact.md')), false);
  });

  it('leaves all pages unchanged when a later patch or index fails', async () => {
    const ws = await fixture();
    await ensureWorkspace(ws, fs);
    const before = await fs.readFile(join(ws.wiki, 'patterns/alpha.md'));
    await assert.rejects(applyMaintain(ws, {
      create_patterns: [{ name: 'android-app-new', content: page('new', 'android-app', 'New trigger.') }],
      update_patterns: [{ name: 'alpha', edits: [{ op: 'replace', target: 'missing substring', content: 'bad' }] }], resync_index: true,
    }, fs));
    assert.equal(await fs.exists(join(ws.wiki, 'patterns/android-app-new.md')), false);
    assert.equal(await fs.readFile(join(ws.wiki, 'patterns/alpha.md')), before);
    await assert.rejects(applyMaintain(ws, { update_index: '- `alpha` — a\n- `alpha` — a\n' }, fs), throwsCode('INDEX_MISMATCH'));
  });

  it('enforces phase tools and path boundaries, including aliases and recursive reads', async () => {
    const ws = await fixture();
    const blocked = (phase: 'inference' | 'maintain' | 'propose', name: string, input: Record<string, unknown>) => toolBlock(phase, name, input, ws.root, [ws]);
    assert.ok(await blocked('inference', 'decx_read', { path: 'index.md' }));
    assert.ok(await blocked('inference', 'read', { path: 'wiki/index.md' }));
    assert.ok(await blocked('inference', 'grep', { path: '.' }));
    assert.ok(await blocked('inference', 'grep', { path: 'skills/demo' }));
    assert.ok(await blocked('inference', 'write', { path: 'raw/traces/new.md' }));
    assert.ok(await blocked('inference', 'write', { path: 'skills/demo/SKILL.md' }));
    assert.equal(await blocked('inference', 'read', { path: 'skills/demo/SKILL.md' }), undefined);
    assert.equal(await blocked('inference', 'decx_trace', {}), undefined);
    assert.ok(await blocked('maintain', 'bash', { command: 'echo hi' }));
    assert.ok(await blocked('maintain', 'write', { path: 'wiki/index.md' }));
    assert.equal(await blocked('maintain', 'decx_maintain', {}), undefined);
    assert.ok(await blocked('propose', 'decx_maintain', {}));
    await symlink(ws.wiki, join(ws.root, 'alias'), 'junction');
    assert.ok(await blocked('inference', 'read', { path: 'alias/index.md' }));
  });
});

describe('candidate validation and rollback', () => {
  it('proposes and gates against a skill installed independently after wiki initialization', async () => {
    const project = await mkdtemp(join(tmpdir(), 'decx-active-'));
    roots.push(project);
    const { workspace: ws } = await initLocalWiki(project, fs);
    const target = 'skills/decx-tool/SKILL.md';
    const active = join(project, '.agents', target);
    const before = '# decx-tool\n';
    await mkdir(join(project, '.agents', 'skills', 'decx-tool'), { recursive: true });
    await writeFile(active, before);
    assert.equal((await readPage(ws, target, fs)).text, before);
    await fs.writeFile(join(ws.wiki, 'patterns', 'alpha.md'), page('alpha', 'android-app', 'Alpha trigger.'));
    const baseline = await writeTrace(ws, { summary: 'baseline', body: 'baseline score 0.5' }, fs);
    const state = join(project, 'agent-state');
    const content = `${before}\n# Candidate\n`;
    await proposeCandidate(ws, { target, content, change: 'test', pattern: 'wiki/patterns/alpha.md', split: 'same-split', baseline: 0.5, baselineTrace: baseline.path }, fs, state);
    assert.equal(await fs.readFile(active), content);
    assert.equal(await fs.exists(join(ws.root, target)), false);
    const result = await gateCandidate(ws, { reject: true, outcome: 'rollback' }, fs, state);
    assert.equal(result.status, 'rejected');
    assert.equal(await fs.readFile(active), before);
  });

  async function candidate() {
    const ws = await fixture();
    const baseline = await writeTrace(ws, { summary: 'baseline', body: 'validation tasks a,b: score 0.5' }, fs);
    const state = join(ws.root, '.agent-state');
    const target = 'skills/demo/SKILL.md';
    const before = await fs.readFile(join(ws.root, target));
    const input = { target, content: `${before}\nCandidate instruction.\n`, change: 'test candidate', pattern: 'wiki/patterns/alpha.md', split: 'validation-v1:a,b', baseline: 0.5, baselineTrace: baseline.path };
    const proposal = await proposeCandidate(ws, input, fs, state);
    return { ws, state, before, input, proposal };
  }

  it('requires same-split evidence and accepts strict improvement', async () => {
    const { ws, state, input, proposal } = await candidate();
    await assert.rejects(proposeCandidate(ws, input, fs, state), throwsCode('PENDING_CANDIDATE'));
    const trace = await writeTrace(ws, { summary: 'candidate', body: 'same tasks a,b: score 1' }, fs);
    await assert.rejects(gateCandidate(ws, { split: 'different', candidate: 1, candidateTrace: trace.path, outcome: 'test' }, fs, state), throwsCode('SPLIT_MISMATCH'));
    await assert.rejects(gateCandidate(ws, { split: input.split, candidate: 1, candidateTrace: input.baselineTrace, outcome: 'test' }, fs, state), throwsCode('BAD_EVIDENCE'));
    const result = await gateCandidate(ws, { split: input.split, candidate: 1, candidateTrace: trace.path, outcome: 'measured' }, fs, state);
    assert.equal(result.status, 'accepted');
    assert.equal(await fs.readFile(join(ws.root, input.target)), input.content);
    assert.ok(await fs.exists(`${candidatePath(ws, state)}.${proposal.id}.json`));
    await assert.rejects(gateCandidate(ws, { reject: true, outcome: 'again' }, fs, state), throwsCode('NO_CANDIDATE'));
  });

  it('rolls back ties and keeps evidence and the wiki', async () => {
    const { ws, state, before, input } = await candidate();
    const trace = await writeTrace(ws, { summary: 'tie', body: 'candidate evaluation score 0.5' }, fs);
    const pattern = await fs.readFile(join(ws.wiki, 'patterns/alpha.md'));
    assert.equal((await gateCandidate(ws, { split: input.split, candidate: 0.5, candidateTrace: trace.path, outcome: 'tie' }, fs, state)).status, 'rejected');
    assert.equal(await fs.readFile(join(ws.root, input.target)), before);
    assert.equal(await fs.readFile(join(ws.wiki, 'patterns/alpha.md')), pattern);
    assert.ok(await fs.exists(join(ws.root, trace.path)));
    assert.match(await fs.readFile(join(ws.wiki, 'skill-impact.md')), /rejected/);
  });

  it('supports unmeasured rejection but refuses to overwrite external edits', async () => {
    const { ws, state, before, input } = await candidate();
    await fs.writeFile(join(ws.root, input.target), 'external edit');
    await assert.rejects(gateCandidate(ws, { reject: true, outcome: 'cancel' }, fs, state), throwsCode('CANDIDATE_CONFLICT'));
    await fs.writeFile(join(ws.root, input.target), input.content);
    assert.equal((await gateCandidate(ws, { reject: true, outcome: 'cancel' }, fs, state)).status, 'rejected');
    assert.equal(await fs.readFile(join(ws.root, input.target)), before);
  });

  it('rejects a tampered state file before it can write outside the workspace', async () => {
    const { ws, state } = await candidate();
    const path = candidatePath(ws, state);
    const pending = JSON.parse(await fs.readFile(path)) as Record<string, unknown>;
    const escaped = join(ws.root, '..', 'escaped.md');
    await rm(escaped, { force: true });
    await fs.writeFile(path, JSON.stringify({ ...pending, target: '../escaped.md' }));
    await assert.rejects(gateCandidate(ws, { reject: true, outcome: 'tampered' }, fs, state), throwsCode('BAD_CANDIDATE'));
    await assert.rejects(fs.exists(escaped), throwsCode('UNSAFE_PATH'));
    await assert.rejects(readFile(escaped), { code: 'ENOENT' });
    await fs.writeFile(path, 'not json');
    await assert.rejects(gateCandidate(ws, { reject: true, outcome: 'broken' }, fs, state), throwsCode('BAD_STATE'));
  });
});

import { withWorkspaceLock } from './node-fs.ts';
describe('write ownership and recovery', () => {
  it('never permits a raw overwrite through the filesystem adapter', async () => {
    const ws = await fixture();
    const trace = await writeTrace(ws, { summary: 'original', body: 'evidence' }, fs);
    await assert.rejects(fs.writeFile(join(ws.root, trace.path), 'replacement'), throwsCode('IMMUTABLE_RAW'));
  });

  it('rejects overlapping workspace writers and releases locks after failures', async () => {
    const ws = await fixture();
    await withWorkspaceLock(ws.root, async () => {
      await assert.rejects(withWorkspaceLock(ws.root, async () => {}), throwsCode('WORKSPACE_BUSY'));
    });
    await assert.rejects(withWorkspaceLock(ws.root, async () => { throw new Error('failed operation'); }), /failed operation/);
    await withWorkspaceLock(ws.root, async () => {});
  });

  it('finishes a durable gate decision after interruption without changing its outcome', async () => {
    const ws = await fixture();
    const baseline = await writeTrace(ws, { summary: 'baseline', body: 'baseline score 0.5' }, fs);
    const measured = await writeTrace(ws, { summary: 'validation', body: 'candidate score 1' }, fs);
    const state = join(ws.root, '.agent-state');
    const target = 'skills/demo/SKILL.md';
    const content = '# accepted candidate\n';
    await proposeCandidate(ws, { target, content, change: 'candidate', pattern: 'wiki/patterns/alpha.md', split: 'v1', baseline: 0.5, baselineTrace: baseline.path }, fs, state);
    const interrupted = { ...fs, async writeFile(path: string, text: string) {
      if (resolve(path) === resolve(ws.wiki, 'skill-impact.md')) throw new Error('simulated disk failure');
      return fs.writeFile(path, text);
    } };
    await assert.rejects(gateCandidate(ws, { split: 'v1', candidate: 1, candidateTrace: measured.path, outcome: 'measured' }, interrupted, state), /simulated disk failure/);
    assert.equal((await gateCandidate(ws, { reject: true, outcome: 'retry' }, fs, state)).status, 'accepted');
    assert.equal(await fs.readFile(join(ws.root, target)), content);
  });
});

import { wikiRefreshTask } from './wiki-command.ts';
describe('one-command wiki refresh', () => {
  it('discovers disk evidence and builds a complete maintenance-only task without writes', async () => {
    const ws = await fixture();
    const trace = await writeTrace(ws, { summary: 'evidence', body: 'UNTRUSTED TRACE BODY' }, fs);
    const text = await wikiRefreshTask([ws], '', fs);
    assert.ok(text.includes(trace.path));
    assert.ok(text.includes('patterns/alpha.md'));
    assert.ok(text.includes('decx_check'));
    assert.ok(text.includes('decx_maintain'));
    assert.ok(text.includes('resync_index: true'));
    assert.ok(text.includes('do not start skill proposals or evaluations'));
    assert.ok(!text.includes('UNTRUSTED TRACE BODY'));
    assert.equal(await fs.exists(join(ws.wiki, 'index.md')), false);
  });

  it('supports workspace selection and explicitly handles no evidence', async () => {
    const first = await fixture();
    const second = { ...await fixture(), name: 'second' };
    const text = await wikiRefreshTask([first, second], 'second', fs);
    assert.ok(text.includes('"workspace": "second"'));
    assert.ok(!text.includes('"workspace": "demo"'));
    assert.ok(text.includes('no traces or no new findings'));
    const all = await wikiRefreshTask([first, second], '', fs);
    assert.ok(all.includes('"workspace": "second"') && all.includes('"workspace": "demo"'));
    await assert.rejects(wikiRefreshTask([], '', fs), /No Decx workspace found/);
    await assert.rejects(wikiRefreshTask([first], 'missing', fs));
  });
});
