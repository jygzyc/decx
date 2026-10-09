import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, link, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { nodeFs, withWorkspaceLock } from './node-fs.ts';
import { initLocalWiki, lintWorkspace } from './lib.ts';

const unsafe = { code: 'UNSAFE_PATH' };

test('filesystem capabilities reject unrelated files, traversal and cross-root inputs', async () => {
  const project = await mkdtemp(join(tmpdir(), 'decx-cap-'));
  try {
    const fs = nodeFs(() => [{ root: project, paths: ['.decxwiki', '.agents/skills'] }]);
    await fs.writeFile(join(project, '.decxwiki', 'wiki', 'page.md'), 'page');
    assert.equal(await fs.readFile(join(project, '.decxwiki', 'wiki', 'page.md')), 'page');
    for (const path of [join(project, 'unrelated'), `${project}/.decxwiki/../unrelated`, `${project}-other/.decxwiki/page.md`]) {
      await assert.rejects(fs.writeFile(path, 'escape'), unsafe);
      await assert.rejects(fs.readFile(path), unsafe);
      await assert.rejects(fs.exists(path), unsafe);
    }
    await assert.rejects(readFile(join(project, 'unrelated')), { code: 'ENOENT' });
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('rejects symlinked ancestors and leaves outside files unchanged', async () => {
  const project = await mkdtemp(join(tmpdir(), 'decx-cap-'));
  const outside = await mkdtemp(join(tmpdir(), 'decx-out-'));
  try {
    await mkdir(join(project, '.decxwiki'));
    await writeFile(join(outside, 'secret'), 'outside');
    await symlink(outside, join(project, '.decxwiki', 'wiki'), process.platform === 'win32' ? 'junction' : 'dir');
    const fs = nodeFs(() => [{ root: project }]);
    const path = join(project, '.decxwiki', 'wiki', 'secret');
    await assert.rejects(fs.readFile(path), unsafe);
    await assert.rejects(fs.writeFile(path, 'changed'), unsafe);
    await assert.rejects(fs.createFile(path, 'changed'), unsafe);
    await assert.rejects(fs.listDir(join(project, '.decxwiki', 'wiki')), unsafe);
    assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'outside');
    await assert.rejects(withWorkspaceLock(join(project, '.decxwiki', 'wiki'), async () => {}), unsafe);
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('cached roots recheck a directory replaced with a symlink', async () => {
  const project = await mkdtemp(join(tmpdir(), 'decx-cap-'));
  const outside = await mkdtemp(join(tmpdir(), 'decx-out-'));
  try {
    const fs = nodeFs(() => [{ root: project, paths: ['.decxwiki'] }]);
    const wiki = join(project, '.decxwiki', 'wiki');
    await fs.writeFile(join(wiki, 'page'), 'original');
    await writeFile(join(outside, 'page'), 'outside');
    await rename(wiki, `${wiki}-old`);
    await symlink(outside, wiki, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(fs.readFile(join(wiki, 'page')), unsafe);
    await assert.rejects(fs.writeFile(join(wiki, 'page'), 'changed'), unsafe);
    assert.equal(await readFile(join(outside, 'page'), 'utf8'), 'outside');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test('lint resolves parent references within production scopes but not outside links', async () => {
  const project = await mkdtemp(join(tmpdir(), 'decx-cap-'));
  try {
    const fs = nodeFs(() => [{ root: project, paths: ['.decxwiki', '.agents/skills'] }]);
    const { workspace } = await initLocalWiki(project, fs);
    const skill = join(project, '.agents', 'skills', 'demo');
    await fs.writeFile(join(skill, 'SKILL.md'), '# Demo\n');
    await fs.writeFile(join(skill, 'PURPOSE.md'), 'Demo.\n');
    await fs.writeFile(join(skill, 'references', 'a.md'), '[parent](../SKILL.md)\n');
    assert.deepEqual(await lintWorkspace(workspace, fs), []);
    await writeFile(join(project, 'secret.md'), 'outside capability');
    await fs.writeFile(join(skill, 'references', 'a.md'), '[parent](../SKILL.md)\n[escape](../../../../secret.md)\n');
    const findings = await lintWorkspace(workspace, fs);
    assert.equal(findings.length, 1);
    assert.equal(findings[0].message, 'link target does not exist: ../../../../secret.md');
  } finally {
    await rm(project, { recursive: true, force: true });
  }
});

test('lock release never removes a replacement project writer lock', async () => {
  const project = await mkdtemp(join(tmpdir(), 'decx-cap-'));
  const moved = `${project}-moved`;
  const workspace = join(project, '.decxwiki');
  let replaced = false;
  let renameDenied = false;
  const lock = join(workspace, '.pi', 'decx-write.lock');
  try {
    try {
      await withWorkspaceLock(workspace, async () => {
        try {
          await rename(project, moved);
        } catch (error) {
          // Windows may prevent moving a directory while fs-safe retains ownership handles.
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
          assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
          renameDenied = true;
          return;
        }
        await mkdir(join(workspace, '.pi'), { recursive: true });
        await writeFile(lock, 'other writer');
        replaced = true;
      });
    } catch (error) {
      // Only a completed replacement grants permission to accept fail-closed cleanup.
      if (!replaced) throw error;
    }
    assert.equal(replaced || renameDenied, true);
    if (replaced) assert.equal(await readFile(lock, 'utf8'), 'other writer');
    else await assert.rejects(readFile(lock), { code: 'ENOENT' });
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(moved, { recursive: true, force: true });
  }
});

test('rejects hardlink reads and cannot mutate their external inode', async () => {
  const project = await mkdtemp(join(tmpdir(), 'decx-cap-'));
  const outside = await mkdtemp(join(tmpdir(), 'decx-out-'));
  try {
    await writeFile(join(outside, 'secret'), 'outside');
    await link(join(outside, 'secret'), join(project, 'alias'));
    const fs = nodeFs(() => [{ root: project }]);
    await assert.rejects(fs.readFile(join(project, 'alias')), unsafe);
    // Replacement may reject the alias or publish an independent inode; neither
    // is allowed to write through to the outside file.
    try { await fs.writeFile(join(project, 'alias'), 'replacement'); } catch (error) {
      assert.equal((error as { code: string }).code, 'UNSAFE_PATH');
    }
    assert.equal(await readFile(join(outside, 'secret'), 'utf8'), 'outside');
  } finally {
    await rm(project, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});
