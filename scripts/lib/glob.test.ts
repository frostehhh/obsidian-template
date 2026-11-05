import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMatcher } from './glob.ts';
import { satisfies, pickTag, isValidRange } from './semver.ts';

test('glob: * stays within a directory, ** crosses directories', () => {
  const m = createMatcher(['Notes/*.md', 'Canvas/**']);
  assert.ok(m('Notes/a.md'));
  assert.ok(!m('Notes/sub/a.md'));
  assert.ok(m('Canvas/a/b/c.canvas'));
  assert.ok(!m('Other/a.md'));
});

test('glob: trailing slash means everything below, **/ matches zero directories', () => {
  assert.ok(createMatcher(['Notes/Templates/'])('Notes/Templates/x/y.md'));
  const m = createMatcher(['**/data.json']);
  assert.ok(m('data.json'));
  assert.ok(m('.obsidian/plugins/quickadd/data.json'));
  assert.ok(!m('data.json.bak'));
});

test('glob: regex characters are literal, matching is anchored', () => {
  const m = createMatcher(['--Configurations--/Scripts/(a).js']);
  assert.ok(m('--Configurations--/Scripts/(a).js'));
  assert.ok(!m('x--Configurations--/Scripts/(a).js'));
  assert.ok(!createMatcher(['a.md'])('aXmd'));
});

test('semver: exact, wildcard, caret and tilde ranges', () => {
  assert.ok(satisfies('v0.3.1', '0.3.1'));
  assert.ok(!satisfies('0.3.2', '0.3.1'));
  assert.ok(satisfies('0.2.9', '0.2.x'));
  assert.ok(!satisfies('0.3.0', '0.2.x'));
  assert.ok(satisfies('0.9.0', '0.x'));
  assert.ok(satisfies('1.0.0', '*'));
  assert.ok(satisfies('0.3.5', '^0.3.1'));
  assert.ok(!satisfies('0.4.0', '^0.3.1'));
  assert.ok(satisfies('1.9.0', '^1.2.3'));
  assert.ok(!satisfies('2.0.0', '^1.2.3'));
  assert.ok(satisfies('0.3.9', '~0.3.0'));
  assert.ok(!satisfies('0.4.0', '~0.3.0'));
});

test('semver: pickTag takes the highest tag in range and ignores non-version tags', () => {
  const tags = ['v0.1.0', 'v0.2.0', 'v0.2.10', 'v0.2.9', 'v0.3.0', 'nightly'];
  assert.equal(pickTag(tags, '0.2.x'), 'v0.2.10');
  assert.equal(pickTag(tags, '^0.3.0'), 'v0.3.0');
  assert.equal(pickTag(tags, '1.x'), null);
});

test('semver: invalid ranges are rejected', () => {
  assert.ok(!isValidRange('latest'));
  assert.ok(!isValidRange('>=1.0.0'));
  assert.ok(isValidRange('0.2.x'));
});
