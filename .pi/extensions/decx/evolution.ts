import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { normalizeRel, readPage, recordProposal, WikiError, type WikiFs, type Workspace } from './lib.ts';

interface Candidate {
  id: string;
  target: string;
  before: string;
  after: string;
  split: string;
  baseline: number;
  baselineTrace: string;
  decision?: { status: 'accepted' | 'rejected'; evaluation: GateInput };
}

interface GateInput {
  split?: string; candidate?: number; candidateTrace?: string; reject?: boolean; outcome: string;
}

export function candidatePath(ws: Workspace, stateDir: string): string {
  return join(stateDir, `candidate-${createHash('sha256').update(ws.root).digest('hex')}.json`);
}

function score(value: number): void {
  if (!Number.isFinite(value) || value < 0 || value > 1) throw new WikiError('BAD_SCORE', 'scores must be finite numbers in [0, 1]');
}

const SKILL_TARGET = /^skills\/[^/]+\/(?:SKILL\.md|PURPOSE\.md|references\/.+)$/;

/** Re-validated on every read: a tampered state file must not redirect writes outside the workspace. */
function skillTarget(target: unknown): string {
  if (typeof target !== 'string') throw new WikiError('BAD_CANDIDATE', 'target must be one existing skill file');
  let normalized: string;
  try {
    normalized = normalizeRel(target);
  } catch {
    throw new WikiError('BAD_CANDIDATE', 'target must be one existing skill file');
  }
  if (!SKILL_TARGET.test(normalized)) throw new WikiError('BAD_CANDIDATE', 'target must be one existing skill file');
  return normalized;
}

function parseCandidate(raw: string): Candidate | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new WikiError('BAD_STATE', 'the pending candidate file is not valid JSON', 'delete the state file to recover');
  }
  if (parsed === null) return null;
  const candidate = parsed as Partial<Candidate>;
  const text = [candidate.id, candidate.target, candidate.before, candidate.after, candidate.split, candidate.baselineTrace];
  if (text.some((value) => typeof value !== 'string') || typeof candidate.baseline !== 'number' || !Number.isFinite(candidate.baseline)) {
    throw new WikiError('BAD_STATE', 'the pending candidate file is malformed', 'delete the state file to recover');
  }
  return candidate as Candidate;
}

async function evidence(ws: Workspace, path: string, fs: WikiFs): Promise<void> {
  if (!/^raw\/traces\/[^/]+\.md$/.test(path)) throw new WikiError('BAD_EVIDENCE', 'cite an immutable raw/traces/<id>.md record');
  await readPage(ws, path, fs);
}

export async function proposeCandidate(ws: Workspace, input: {
  target: string; content: string; change: string; pattern: string;
  split: string; baseline: number; baselineTrace: string;
}, fs: WikiFs, stateDir: string): Promise<{ id: string }> {
  const statePath = candidatePath(ws, stateDir);
  if (await fs.exists(statePath) && (await fs.readFile(statePath)).trim() !== 'null') {
    throw new WikiError('PENDING_CANDIDATE', 'gate the existing candidate before proposing another');
  }
  score(input.baseline);
  if (!input.split.trim() || !input.content.trim()) throw new WikiError('BAD_CANDIDATE', 'a candidate needs a validation split and nonempty content');
  await evidence(ws, input.baselineTrace, fs);
  if (!/^wiki\/patterns\/[^/]+\.md$/.test(input.pattern)) throw new WikiError('BAD_EVIDENCE', 'cite a consolidated wiki/patterns/<slug>.md page');
  await readPage(ws, input.pattern, fs);
  const target = skillTarget(input.target);
  const before = (await readPage(ws, target, fs)).text;
  if (before === input.content) throw new WikiError('BAD_CANDIDATE', 'candidate is unchanged');
  const proposal = await recordProposal(ws, { target, change: input.change, evidence: `${input.pattern}; ${input.baselineTrace}` }, fs);
  const candidate: Candidate = { id: proposal.id, target, before, after: input.content, split: input.split, baseline: input.baseline, baselineTrace: input.baselineTrace };
  // Save recovery data before applying the candidate. A failed write is recoverable by rejection.
  await fs.writeFile(statePath, JSON.stringify(candidate, null, 2));
  await fs.writeFile(join(ws.root, target), input.content);
  return { id: proposal.id };
}

export async function gateCandidate(ws: Workspace, input: GateInput, fs: WikiFs, stateDir: string): Promise<{ id: string; status: 'accepted' | 'rejected' }> {
  const statePath = candidatePath(ws, stateDir);
  if (!(await fs.exists(statePath))) throw new WikiError('NO_CANDIDATE', 'no pending candidate');
  const pending = parseCandidate(await fs.readFile(statePath));
  if (!pending) throw new WikiError('NO_CANDIDATE', 'no pending candidate');
  pending.target = skillTarget(pending.target);
  const current = await fs.readFile(join(ws.root, pending.target));
  if (current !== pending.after && current !== pending.before) throw new WikiError('CANDIDATE_CONFLICT', 'skill changed outside the proposal; refusing to overwrite it');
  // Once a decision is durable, retries finish that decision rather than changing it.
  input = pending.decision?.evaluation ?? input;
  if (!input.reject && !pending.decision) {
    score(input.candidate!);
    if (current !== pending.after) throw new WikiError('CANDIDATE_CONFLICT', 'candidate is not applied; reject it to recover');
    if (input.split !== pending.split) throw new WikiError('SPLIT_MISMATCH', 'baseline and candidate must use the same validation split');
    await evidence(ws, input.candidateTrace ?? '', fs);
    if (input.candidateTrace === pending.baselineTrace) throw new WikiError('BAD_EVIDENCE', 'candidate requires its own evaluation trace');
  }
  const status = pending.decision?.status ?? (!input.reject && input.candidate! > pending.baseline ? 'accepted' : 'rejected');
  if (status === 'accepted' && current !== pending.after) throw new WikiError('CANDIDATE_CONFLICT', 'accepted candidate is no longer applied');
  pending.decision = { status, evaluation: input };
  await fs.writeFile(statePath, JSON.stringify(pending, null, 2));
  if (status === 'rejected') await fs.writeFile(join(ws.root, pending.target), pending.before);
  await recordProposal(ws, {
    id: pending.id, target: pending.target, change: '', status,
    score: input.reject ? 'not evaluated' : `${input.candidate} vs ${pending.baseline}; split=${pending.split}`,
    outcome: `${input.outcome}; baseline=${pending.baselineTrace}; candidate=${input.candidateTrace ?? 'none'}`,
  }, fs);
  await fs.createFile(`${statePath}.${pending.id}.json`, JSON.stringify({ ...pending, status, evaluation: input }, null, 2));
  await fs.writeFile(statePath, 'null\n');
  return { id: pending.id, status };
}
