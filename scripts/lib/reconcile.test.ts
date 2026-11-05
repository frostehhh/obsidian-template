import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, resolve, applyProtection } from './reconcile.ts';
import type { FileDecision } from './reconcile.ts';

// t = template, b = base (lock), v = vault; undefined = absent.
test('decide: identical template and vault is a noop', () => {
  assert.equal(decide('a', 'x', 'a'), 'noop');
  assert.equal(decide('a', undefined, 'a'), 'noop');
  assert.equal(decide(undefined, undefined, undefined), 'noop');
});

test('decide: untouched vault takes template changes', () => {
  assert.equal(decide('new', 'old', 'old'), 'update');
  assert.equal(decide('new', undefined, undefined), 'add');
  assert.equal(decide(undefined, 'old', 'old'), 'delete');
});

test('decide: local changes are kept when the template did not change', () => {
  assert.equal(decide('base', 'base', 'local'), 'keep');
  assert.equal(decide('base', 'base', undefined), 'keep'); // deleted locally stays deleted
});

test('decide: changes on both sides conflict', () => {
  assert.equal(decide('new', 'old', 'local'), 'conflict');
  assert.equal(decide(undefined, 'old', 'local'), 'conflict'); // removed upstream, edited locally
  assert.equal(decide('new', undefined, 'local'), 'conflict'); // no lock: existing file differs
});

test('decide: vault-only files are never touched', () => {
  assert.equal(decide(undefined, undefined, 'mine'), 'keep');
});

function decision(action: FileDecision['action'], t?: string, b?: string): FileDecision {
  return { file: 'f', action, templateHash: t, baseHash: b, vaultHash: undefined, tracked: true };
}

test('resolve: lock records the template hash after a clean update', () => {
  assert.deepEqual(resolve(decision('update', 'n', 'o'), 'skip'), { effect: 'write', base: 'n', conflict: false });
  assert.deepEqual(resolve(decision('delete', undefined, 'o'), 'skip'), { effect: 'delete', base: undefined, conflict: false });
});

test('resolve: keep leaves the base alone', () => {
  assert.deepEqual(resolve(decision('keep', 'b', 'b'), 'skip'), { effect: 'none', base: 'b', conflict: false });
});

test('protection turns every write, delete or conflict into protected, and leaves the rest', () => {
  for (const action of ['add', 'update', 'delete', 'conflict'] as const) {
    assert.equal(applyProtection(action, true), 'protected');
    assert.equal(applyProtection(action, false), action);
  }
  assert.equal(applyProtection('noop', true), 'noop');
  assert.equal(applyProtection('keep', true), 'keep');
  assert.deepEqual(resolve(decision('protected', 'n', 'o'), 'take-template'), { effect: 'none', base: 'o', conflict: false });
});

test('resolve: conflict policies', () => {
  const c = decision('conflict', 'n', 'o');
  assert.deepEqual(resolve(c, 'skip'), { effect: 'none', base: 'o', conflict: true });
  assert.deepEqual(resolve(c, 'take-template'), { effect: 'write', base: 'n', conflict: false });
  assert.deepEqual(resolve(c, 'keep-vault'), { effect: 'none', base: 'n', conflict: false });
  const removed = decision('conflict', undefined, 'o');
  assert.deepEqual(resolve(removed, 'take-template'), { effect: 'delete', base: undefined, conflict: false });
});
