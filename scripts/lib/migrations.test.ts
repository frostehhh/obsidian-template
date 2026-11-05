import { test } from 'node:test';
import assert from 'node:assert/strict';
import { planMigrations } from './migrations.ts';
import type { Lock } from './types.ts';

const available = ['0.2.0', '0.3.0', '0.3.2', '0.4.0'];

function lock(versions: string[], migrations?: string[]): Lock {
  const items: Lock['items'] = {};
  versions.forEach((v, i) => (items[`dir:d${i}`] = { templateVersion: v, files: {} }));
  return migrations ? { lockVersion: 1, items, migrations } : { lockVersion: 1, items };
}

test('planMigrations: a lock that records migrations is authoritative', () => {
  const plan = planMigrations(available, lock(['0.3.0'], ['0.2.0', '0.3.0']), undefined, '0.4.0');
  assert.deepEqual(plan.pending, ['0.3.2', '0.4.0']);
  assert.deepEqual(plan.record, ['0.2.0', '0.3.0', '0.3.2', '0.4.0']);
});

test('planMigrations: migrations newer than the target wait', () => {
  const plan = planMigrations(available, lock(['0.3.0'], ['0.2.0', '0.3.0']), undefined, '0.3.2');
  assert.deepEqual(plan.pending, ['0.3.2']);
});

test('planMigrations: syncing an older tag runs nothing and never forgets applied ones', () => {
  const plan = planMigrations(available, lock(['0.4.0'], ['0.2.0', '0.3.0', '0.3.2', '0.4.0']), undefined, '0.3.0');
  assert.deepEqual(plan.pending, []);
  assert.deepEqual(plan.record, ['0.2.0', '0.3.0', '0.3.2', '0.4.0']);
});

test('planMigrations: a lock without migrations uses the oldest synced item as baseline', () => {
  const plan = planMigrations(available, lock(['0.3.0', '0.2.0']), undefined, '0.4.0');
  assert.deepEqual(plan.pending, ['0.3.0', '0.3.2', '0.4.0']);
  assert.deepEqual(plan.record, ['0.2.0', '0.3.0', '0.3.2', '0.4.0']);
});

test('planMigrations: an untracked vault runs nothing, unless --assume gives a baseline', () => {
  const fresh = planMigrations(available, null, undefined, '0.4.0');
  assert.deepEqual(fresh.pending, []);
  assert.deepEqual(fresh.record, available);
  const assumed = planMigrations(available, null, '0.3.0', '0.4.0');
  assert.deepEqual(assumed.pending, ['0.3.2', '0.4.0']);
  assert.deepEqual(assumed.record, ['0.2.0', '0.3.0', '0.3.2', '0.4.0']);
});

test('planMigrations: working-tree has no upper bound', () => {
  const plan = planMigrations(available, lock(['0.3.0'], ['0.2.0', '0.3.0']), undefined, 'working-tree');
  assert.deepEqual(plan.pending, ['0.3.2', '0.4.0']);
});
