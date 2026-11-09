import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  ABSENT,
  UNKNOWN,
  checkDecisions,
  classify,
  declineMatcher,
  diffJson,
  formatKey,
  getAt,
  jsonHash,
  matchScore,
  parseKey,
  renameState,
  resolveScope,
  scriptRefs,
  setAt,
} from './vaultupdate.ts';
import type { Entry } from './vaultupdate.ts';
import { loadLock, readLockFile, serializeLockV2 } from './lock.ts';
import { makeVault } from './cli.ts';

test('classify: old / vault / new', () => {
  assert.equal(classify('o', 'n', 'n'), 'done');
  assert.equal(classify('o', 'o', 'n'), 'apply');
  assert.equal(classify('o', 'o', 'n', true), 'apply-auto');
  assert.equal(classify(ABSENT, ABSENT, 'n'), 'apply'); // added in the template
  assert.equal(classify('o', 'o', ABSENT), 'apply'); // deleted in the template
  assert.equal(classify('o', 'local', 'n'), 'conflict');
  assert.equal(classify('o', ABSENT, 'n'), 'conflict'); // deleted in the vault, changed in the template
  assert.equal(classify(UNKNOWN, ABSENT, 'n'), 'apply-nobase');
  assert.equal(classify(UNKNOWN, 'x', 'n'), 'conflict');
  assert.equal(classify(UNKNOWN, 'n', 'n'), 'done');
});

test('renameState: move only when the old path still holds the old content', () => {
  assert.equal(renameState('o', 'n', 'o', ABSENT), 'apply');
  assert.equal(renameState('o', 'n', ABSENT, 'n'), 'done');
  assert.equal(renameState('o', 'n', 'edited', ABSENT), 'conflict');
  assert.equal(renameState('o', 'n', 'o', 'other'), 'conflict');
});

test('key paths round-trip', () => {
  const segs = [{ key: 'choices' }, { id: '5c1d-8a52' }, { key: 'macro' }, { key: 'a.b' }];
  const text = formatKey(segs);
  assert.equal(text, 'choices[5c1d-8a52].macro["a.b"]');
  assert.deepEqual(parseKey(text), segs);
  assert.deepEqual(parseKey('desktop.plugins.obsidian-git.startupType').length, 4);
});

test('diffJson: objects by key, id arrays by id, other arrays whole', () => {
  const old = { a: 1, list: [1, 2], choices: [{ id: 'x', name: 'X', v: 1 }], nested: { keep: true, b: 1 } };
  const next = { a: 1, list: [1, 3], choices: [{ id: 'x', name: 'X', v: 2 }, { id: 'y', name: 'Y' }], nested: { keep: true } };
  const keys = diffJson(old, next).map((d) => formatKey(d.segs)).sort();
  assert.deepEqual(keys, ['choices[x].v', 'choices[y]', 'list', 'nested.b']);
});

test('diffJson baseless: compares with the vault and leaves vault-only keys alone', () => {
  const vault = { mine: 1, shared: 1, choices: [{ id: 'own', name: 'Own' }] };
  const next = { shared: 2, choices: [{ id: 't', name: 'T' }] };
  const keys = diffJson(vault, next, true).map((d) => formatKey(d.segs)).sort();
  assert.deepEqual(keys, ['choices[t]', 'shared']);
});

test('getAt / setAt: set, append by id, delete', () => {
  const doc = { choices: [{ id: 'a', name: 'A' }] };
  assert.equal(getAt(doc, parseKey('choices[a].name')), 'A');
  const added = setAt(doc, parseKey('choices[b]'), { id: 'b', name: 'B' });
  assert.deepEqual(getAt(added, parseKey('choices[b].name')), 'B');
  const removed = setAt(added, parseKey('choices[a]'), undefined);
  assert.deepEqual(removed, { choices: [{ id: 'b', name: 'B' }] });
  assert.deepEqual(setAt({}, parseKey('x.y'), 1), { x: { y: 1 } });
  assert.deepEqual(doc, { choices: [{ id: 'a', name: 'A' }] }); // input untouched
});

test('jsonHash ignores key order', () => {
  assert.equal(jsonHash({ a: 1, b: 2 }), jsonHash({ b: 2, a: 1 }));
  assert.equal(jsonHash(undefined), ABSENT);
});

test('declineMatcher: paths, globs and key prefixes', () => {
  const m = declineMatcher(['Scripts/qa-x.js', 'Notes/**', 'data.json#choices[a]']);
  assert.ok(m('Scripts/qa-x.js'));
  assert.ok(m('Notes/deep/n.md'));
  assert.ok(m('data.json', 'choices[a]'));
  assert.ok(m('data.json', 'choices[a].macro.name'));
  assert.equal(m('data.json', 'choices[ab]'), undefined);
  assert.equal(m('data.json'), undefined);
  assert.ok(m('new/place.js', undefined, 'Scripts/qa-x.js')); // a move of a declined file
});

test('resolveScope: CLI > vault config > lock > repo config, linked dirs, exclude', () => {
  const none = { isExcluded: () => false };
  const repo = { defaultPlugins: ['dataview'], defaultDirs: ['Notes'], defaultSettings: ['templates.json'], syncDataJson: false };
  const fromRepo = resolveScope({}, repo, null, {}, none);
  assert.deepEqual(fromRepo.plugins, ['dataview']);
  assert.equal(fromRepo.sources.plugins, 'repo config');

  const fromLock = resolveScope({}, repo, ['plugin:quickadd', 'dir:Bases'], {}, none);
  assert.deepEqual(fromLock.plugins, ['quickadd']);
  assert.ok(fromLock.dirs.includes('--Configurations--/Scripts')); // linked to quickadd
  assert.deepEqual(fromLock.settings, []);

  const fromVault = resolveScope({ defaultPlugins: ['excalibrain'], syncDataJson: true }, repo, ['plugin:quickadd'], {}, none);
  assert.deepEqual(fromVault.plugins, ['excalibrain']);
  assert.ok(fromVault.dirs.includes('ExcaliBrain'));
  assert.equal(fromVault.syncDataJson, true);

  const cli = resolveScope({ defaultPlugins: ['excalibrain'] }, repo, null, { plugins: ['omnisearch'], dataJson: false }, none);
  assert.deepEqual(cli.plugins, ['omnisearch']);
  assert.equal(cli.syncDataJson, false);

  const excluded = resolveScope({}, repo, null, {}, { isExcluded: (i) => i.kind === 'dir' && i.id === 'Notes' });
  assert.ok(!excluded.items.includes('dir:Notes'));
  assert.deepEqual(excluded.excluded, ['dir:Notes']);
});

test('matchScore: exact only with the same files and hashes', () => {
  const recorded = new Map([['a', '1'], ['b', '2']]);
  assert.deepEqual(matchScore(recorded, new Map([['a', '1'], ['b', '2']])), { matched: 2, exact: true });
  assert.deepEqual(matchScore(recorded, new Map([['a', '1'], ['b', '2'], ['c', '3']])), { matched: 2, exact: false });
  assert.deepEqual(matchScore(recorded, new Map([['a', '1'], ['b', 'x']])), { matched: 1, exact: false });
});

test('scriptRefs: vaultRequire paths inside the QuickAdd scripts folder', () => {
  const src = 'await vaultRequire(app, "lib/utils"); await vaultRequire(app, \'lib/TaskNotes/helpers.js\')';
  assert.deepEqual(scriptRefs('--Configurations--/Scripts/QuickAdd/qa-x.js', src), [
    '--Configurations--/Scripts/QuickAdd/lib/TaskNotes/helpers.js',
    '--Configurations--/Scripts/QuickAdd/lib/utils.js',
  ]);
  assert.deepEqual(scriptRefs('Notes/x.js', src), []);
});

function entry(id: string, state: Entry['state'], extra: Partial<Entry> = {}): Entry {
  const [path, key] = id.split('#') as [string, string | undefined];
  return { id, item: 'dir:X', path, ...(key ? { key } : {}), change: 'add', old: ABSENT, vault: ABSENT, new: 'n', state, commits: [], baseVersion: '0.4.0', ...extra };
}

test('checkDecisions: every open entry needs a decision', () => {
  const entries = [entry('a.js', 'apply'), entry('b.js', 'conflict', { change: 'modify', old: 'o', vault: 'v' }), entry('c.js', 'done')];
  const missing = checkDecisions(entries, { keep: [], defer: [], decline: {} }, '0.4.0');
  assert.equal(missing.problems.length, 2);

  const ok = checkDecisions(entries, { keep: ['b.js'], defer: ['a.js'], decline: {} }, '0.4.0');
  assert.deepEqual(ok.problems, []);
  assert.deepEqual(ok.pending, { 'a.js': { old: ABSENT, since: '0.4.0' } });
  assert.deepEqual(ok.kept, ['b.js']);
});

test('checkDecisions: keep is for conflicts, unknown ids and unmatched declines are refused', () => {
  const entries = [entry('a.js', 'apply'), entry('d.json#choices[x]', 'apply', { label: 'Choice X' })];
  const bad = checkDecisions(entries, { keep: ['a.js'], defer: ['nope'], decline: { 'zzz/**': '' } }, '0.4.0');
  assert.ok(bad.problems.some((p) => p.includes('only conflicts')));
  assert.ok(bad.problems.some((p) => p.includes('--defer nope')));
  assert.ok(bad.problems.some((p) => p.includes('--decline zzz/**')));

  const declined = checkDecisions(entries, { keep: [], defer: ['a.js'], decline: { 'd.json#choices[x]': '' } }, '0.4.0');
  assert.deepEqual(declined.problems, []);
  assert.deepEqual(declined.declines, { 'd.json#choices[x]': 'Choice X' });
});

test('checkDecisions: deferring keeps an earlier pending since, and a move defers both paths', () => {
  const entries = [
    entry('a.js', 'apply', { pending: '0.3.0' }),
    entry('new/b.js', 'apply', { change: 'rename', from: 'old/b.js', old: 'o' }),
  ];
  const r = checkDecisions(entries, { keep: [], defer: ['a.js', 'new/b.js'], decline: {} }, '0.4.0');
  assert.deepEqual(r.pending, {
    'a.js': { old: ABSENT, since: '0.3.0' },
    'old/b.js': { old: 'o', since: '0.4.0' },
    'new/b.js': { old: ABSENT, since: '0.4.0' },
  });
});

test('lock v2: deterministic output; the draft sync refuses it', async () => {
  const a = serializeLockV2({ lockVersion: 2, commit: 'c', version: '0.4.0', items: ['plugin:b', 'dir:a', 'plugin:b'], pending: { z: { old: '-', since: '0.4.0' }, a: { old: 'h', since: '0.3.0' } } });
  const b = serializeLockV2({ lockVersion: 2, commit: 'c', version: '0.4.0', items: ['dir:a', 'plugin:b'], pending: { a: { old: 'h', since: '0.3.0' }, z: { old: '-', since: '0.4.0' } } });
  assert.equal(a, b);
  assert.ok(!serializeLockV2({ lockVersion: 2, commit: 'c', version: 'v', items: [], pending: {} }).includes('pending'));

  const root = await mkdtemp(join(tmpdir(), 'vu-lock-'));
  await mkdir(join(root, '.obsidian'));
  await writeFile(join(root, '.obsidian', 'template.lock.json'), a);
  const vault = makeVault('T', root);
  assert.equal((await readLockFile(vault))?.lockVersion, 2);
  await assert.rejects(loadLock(vault), /managed by vault-update/);
});
