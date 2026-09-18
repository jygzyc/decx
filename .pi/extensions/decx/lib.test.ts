import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const fs = nodeFs();
const roots: string[] = [];

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
  it('discovers the project itself and configured roots, never a skill-local wiki', async () => {
    const workspace = await fixture();
    const found = await discoverWorkspaces(workspace.root, fs);
    assert.equal(found.length, 1);
    const [only] = found;
    assert.equal(only.root, workspace.root);
    assert.equal(only.wiki, join(workspace.root, 'wiki'));
    assert.equal(only.raw, join(workspace.root, 'raw'));
    assert.equal(only.skills, join(workspace.root, 'skills'));

    await mkdir(join(workspace.root, 'skills', 'demo', 'wiki'), { recursive: true });
    assert.deepEqual(
      (await discoverWorkspaces(workspace.root, fs)).map((item) => item.name),
      [only.name],
      'a wiki nested in a skill is not a workspace',
    );

    const configured = await discoverWorkspaces(workspace.root, fs, [{ name: 'decx', root: '.' }]);
    assert.deepEqual(
      configured.map((item) => item.name),
      ['decx'],
    );
    assert.equal(configured[0].wiki, join(workspace.root, 'wiki'));
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
