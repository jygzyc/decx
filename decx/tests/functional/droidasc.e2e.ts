import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { analyze, analyzeFailure, fixtures } from './helpers.ts';

const provider = 'com.withsecure.example.sieve.provider.DBContentProvider';
const uri = `content://${provider}/Passwords`;
// Python stdout and saved files may use different platform line endings.
const text = (value: string): string => value.replaceAll('\r\n', '\n').trim();

test('real APK: manifest, DEX enumeration, Java decompilation and code references through DECX', { timeout: 180_000 }, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'decx-real-apk-'));
  t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
  const bytes = fs.readFileSync(path.join(fixtures, 'sieve.apk'));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), '85fe7a89866728e3990c11aeb8768ef5ba76accd9893ca6553d782b871312bdf');
  const apk = path.join(temporary, '应用 with spaces.apk');
  fs.writeFileSync(apk, bytes);

  await t.test('decode real binary AndroidManifest.xml', () => {
    const output = path.join(temporary, 'manifest.xml');
    const xml = analyze('droidasc', ['getmanifest', apk, '-o', output], temporary);
    assert.match(xml, /package="com\.withsecure\.example\.sieve"/);
    assert.match(xml, /provider\.DBContentProvider/);
    assert.equal(text(fs.readFileSync(output, 'utf8')), text(xml));
  });

  await t.test('enumerate actual DEX classes', () => {
    const classes = analyze('droidasc', ['listclass', apk, '--prefix', 'com.withsecure.example.sieve'], temporary).split(/\r?\n/);
    assert.ok(classes.includes('Lcom/withsecure/example/sieve/provider/DBContentProvider;'));
    assert.ok(classes.includes('Lcom/withsecure/example/sieve/util/PWDBHelper;'));
    assert.ok(classes.filter(Boolean).every(name => name.startsWith('Lcom/withsecure/example/sieve/')));
  });

  await t.test('decompile SQL provider methods and verify written Java source', () => {
    const output = path.join(temporary, 'DBContentProvider.java');
    const code = analyze('droidasc', ['getclass', apk, provider, '--threads', '2', '-o', output], temporary);
    assert.match(code, /class DBContentProvider extends android\.content\.ContentProvider/);
    assert.match(code, /android\.database\.Cursor query\(/);
    assert.match(code, /SQLiteQueryBuilder/);
    assert.match(code, /setTables\("Passwords"\)/);
    assert.match(code, /getWritableDatabase\(\)\.delete\("Passwords"/);
    assert.ok(code.includes(uri));
    assert.equal(text(fs.readFileSync(output, 'utf8')), text(code));
    const descriptorCode = analyze('droidasc', ['getclass', apk, `L${provider.replaceAll('.', '/')};`, '--threads', '2'], temporary);
    assert.equal(text(descriptorCode), text(code));
  });

  await t.test('locate a real string reference in a DEX instruction', () => {
    const refs = analyze('droidasc', ['findrefs', apk, 'string', uri], temporary);
    assert.match(refs, /classes\d*\.dex/);
    assert.match(refs, /DBContentProvider;-><clinit>/);
    assert.ok(refs.includes(uri));
  });

  await t.test('missing class fails through the actual analyzer', () => {
    const result = analyzeFailure('droidasc', ['getclass', apk, 'com.decx.DefinitelyMissing'], temporary);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Class Lcom\/decx\/DefinitelyMissing; not found in APK/);
  });
});
