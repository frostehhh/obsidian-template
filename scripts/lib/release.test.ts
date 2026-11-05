import { test } from 'node:test';
import assert from 'node:assert/strict';
import { migrationProblem } from './release.ts';

const withMigration = '## Changed\n\n- Renamed a macro\n  - **Migration:** re-sync QuickAdd\n';

test('migrationProblem: no Migration entry, nothing to check', () => {
  assert.equal(migrationProblem('0.4.0', '## Added\n\n- A thing\n', false), null);
});

test('migrationProblem: the **Migration** hint in the changelog template comment does not count', () => {
  const template = '# Unreleased\n\n<!-- Breaking changes need a **Migration** note. -->\n\n- A thing\n';
  assert.equal(migrationProblem('0.4.0', template, false), null);
});

test('migrationProblem: a Migration entry needs a migration file or an explicit none', () => {
  assert.match(migrationProblem('0.4.0', withMigration, false) ?? '', /migrations\/0\.4\.0\.ts does not exist/);
  assert.equal(migrationProblem('0.4.0', withMigration, true), null);
  assert.equal(migrationProblem('0.4.0', `${withMigration}\n<!-- migrations: none -->\n`, false), null);
});
