import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergePatch, merge3, patchCovers, resolveMerge, setPath, formatLike } from './jsonmerge.ts';

test('mergePatch: RFC 7386 examples', () => {
  assert.deepEqual(mergePatch({ a: 'b', c: { d: 'e', f: 'g' } }, { a: 'z', c: { f: null } }), { a: 'z', c: { d: 'e' } });
  assert.deepEqual(mergePatch({ a: [1, 2] }, { a: [3] }), { a: [3] });
  assert.deepEqual(mergePatch({ a: 1 }, { b: { c: 2 } }), { a: 1, b: { c: 2 } });
  assert.deepEqual(mergePatch('x', { a: 1 }), { a: 1 });
});

test('merge3: each side keeps its own changes', () => {
  const base = { a: 1, b: 1, c: 1 };
  const template = { a: 2, b: 1, c: 1, d: 1 };
  const vault = { a: 1, b: 9, c: 1 };
  const { merged, conflicts } = merge3(base, template, vault);
  assert.deepEqual(merged, { a: 2, b: 9, c: 1, d: 1 });
  assert.deepEqual(conflicts, []);
});

test('merge3: template removals apply only when the vault did not touch the key', () => {
  const base = { a: 1, b: 1 };
  const template = { a: 1 };
  assert.deepEqual(merge3(base, template, { a: 1, b: 1 }).merged, { a: 1 });
  const touched = merge3(base, template, { a: 1, b: 2 });
  assert.deepEqual(touched.merged, { a: 1, b: 2 });
  assert.deepEqual(touched.conflicts, [{ path: ['b'], template: undefined }]);
});

test('merge3: nested objects merge key by key, arrays are atomic', () => {
  const base = { s: { x: 1, y: 1 }, list: [1] };
  const template = { s: { x: 2, y: 1 }, list: [1, 2] };
  const vault = { s: { x: 1, y: 5 }, list: [9] };
  const { merged, conflicts } = merge3(base, template, vault);
  assert.deepEqual(merged, { s: { x: 2, y: 5 }, list: [9] });
  assert.deepEqual(conflicts, [{ path: ['list'], template: [1, 2] }]);
});

test('merge3: an empty base makes every difference a conflict but still adds new keys', () => {
  const { merged, conflicts } = merge3({}, { a: 1, n: 1 }, { a: 2, v: 1 });
  assert.deepEqual(merged, { a: 2, v: 1, n: 1 });
  assert.deepEqual(conflicts, [{ path: ['a'], template: 1 }]);
});

test('resolveMerge: take-template applies the template side of conflicts, including removals', () => {
  const m = merge3({ a: 1, b: 1 }, { a: 2 }, { a: 3, b: 2 });
  assert.deepEqual(resolveMerge(m, false), { a: 3, b: 2 });
  assert.deepEqual(resolveMerge(m, true), { a: 2 });
});

test('merge3: arrays of objects with ids merge element by element', () => {
  const base = [{ id: 'a', name: 'A', on: true }, { id: 'b', name: 'B', on: true }];
  const template = [{ id: 'a', name: 'A2', on: false }, { id: 'b', name: 'B', on: true }, { id: 'n', name: 'New' }];
  const vault = [{ id: 'mine', name: 'Mine' }, { id: 'a', name: 'A', on: true }, { id: 'b', name: 'B-local', on: true }];
  const { merged, conflicts } = merge3({ choices: base }, { choices: template }, { choices: vault });
  assert.deepEqual(merged, {
    choices: [
      { id: 'mine', name: 'Mine' },
      { id: 'a', name: 'A2', on: false },
      { id: 'b', name: 'B-local', on: true },
      { id: 'n', name: 'New' },
    ],
  });
  assert.deepEqual(conflicts, []);
});

test('merge3: id-keyed arrays report conflicts by id and respect removals', () => {
  const base = [{ id: 'a', v: 1 }, { id: 'b', v: 1 }];
  const template = [{ id: 'a', v: 2 }]; // b removed upstream
  const vault = [{ id: 'a', v: 3 }, { id: 'b', v: 1 }];
  const m = merge3(base, template, vault);
  assert.deepEqual(m.merged, [{ id: 'a', v: 3 }]);
  assert.deepEqual(m.conflicts, [{ path: ['a', 'v'], template: 2 }]);
  assert.deepEqual(resolveMerge(m, true), [{ id: 'a', v: 2 }]);
});

test('merge3: arrays without ids stay atomic', () => {
  const m = merge3({ l: [1] }, { l: [1, 2] }, { l: [9] });
  assert.deepEqual(m.merged, { l: [9] });
  assert.deepEqual(resolveMerge(m, true), { l: [1, 2] });
});

test('setPath and patchCovers', () => {
  assert.deepEqual(setPath({ a: { b: 1 } }, ['a', 'c'], 2), { a: { b: 1, c: 2 } });
  assert.deepEqual(setPath({ a: { b: 1 } }, ['a', 'b'], undefined), { a: {} });
  assert.ok(patchCovers({ a: { b: 1 } }, ['a', 'b']));
  assert.ok(patchCovers({ a: 5 }, ['a', 'b', 'c']));
  assert.ok(!patchCovers({ a: { b: 1 } }, ['a', 'x']));
  assert.ok(!patchCovers({ a: 1 }, ['z']));
});

test('formatLike keeps the indent and the trailing newline of the original', () => {
  assert.equal(formatLike('{\n\t"a": 1\n}\n', { a: 2 }), '{\n\t"a": 2\n}\n');
  assert.equal(formatLike('{\n    "a": 1\n}', { a: 2 }), '{\n    "a": 2\n}');
  assert.equal(formatLike('{}', { a: 2 }), '{\n  "a": 2\n}');
});
