import * as p from '@clack/prompts';
import { execFileSync } from 'child_process';
import { readFile, writeFile, rename, stat } from 'fs/promises';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CHANGELOG_DIR = join(REPO_ROOT, 'changelog');
const INDEX_PATH = join(REPO_ROOT, 'CHANGELOG.md');
const UNRELEASED_PATH = join(CHANGELOG_DIR, 'unreleased.md');
const PACKAGE_PATH = join(REPO_ROOT, 'package.json');
const RELEASE_BRANCH = 'master';
const BUMPS = ['patch', 'minor', 'major'];
const SEMVER = /^\d+\.\d+\.\d+$/;

const UNRELEASED_TEMPLATE = `# Unreleased

<!-- One line per user-visible change, added in the same commit as the change.
Group under Added / Changed / Deprecated / Removed / Fixed / Security.
Breaking changes need a **Migration** note. -->
`;

function git(...args) {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

async function pathExists(target) {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

function fail(msg) {
  p.cancel(msg);
  process.exit(1);
}

function latestTagVersion() {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v*').slice(1);
  } catch {
    return null;
  }
}

function nextVersion(current, bump) {
  const [major, minor, patch] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

function hasEntries(markdown) {
  const withoutComments = markdown.replace(/<!--[\s\S]*?-->/g, '');
  return /^\s*[-*]\s+\S/m.test(withoutComments);
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const assumeYes = args.includes('--yes');
  const target = args.find((a) => !a.startsWith('--'));

  p.intro('  release  —  Obsidian Template');

  if (!target) {
    fail('Usage: mise run release <patch|minor|major|x.y.z> [--dry-run] [--yes]');
  }

  // Preconditions
  if (git('status', '--porcelain', '--untracked-files=no')) fail('Working tree is not clean. Commit or stash changes first.');
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== RELEASE_BRANCH) fail(`Releases are cut from ${RELEASE_BRANCH}, but the current branch is ${branch}.`);

  try {
    execFileSync('node', [join(REPO_ROOT, 'scripts', 'state', 'state.js'), '--check'], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch (err) {
    fail(`state.json is out of date. Run \`mise run state\`, commit it, then retry.\n${err.stderr?.toString().trim() ?? ''}`);
  }

  const unreleased = (await pathExists(UNRELEASED_PATH)) ? await readFile(UNRELEASED_PATH, 'utf8') : '';
  const unreleasedHasEntries = hasEntries(unreleased);

  // Resolve the version
  const current = latestTagVersion();
  let version;
  if (BUMPS.includes(target)) {
    if (!current) fail('No v* tag exists yet. Pass an explicit version (e.g. 0.1.0) for the first release.');
    version = nextVersion(current, target);
  } else if (SEMVER.test(target)) {
    version = target;
  } else {
    fail(`"${target}" is not patch, minor, major or an x.y.z version.`);
  }

  const tag = `v${version}`;
  if (git('tag', '--list', tag)) fail(`Tag ${tag} already exists.`);

  // A pre-written changelog/<version>.md (the baseline) replaces the unreleased rollover
  const releaseFile = join(CHANGELOG_DIR, `${version}.md`);
  const baseline = await pathExists(releaseFile);
  if (baseline && unreleasedHasEntries) {
    fail(`changelog/${version}.md already exists and unreleased.md also has entries. Merge them first.`);
  }
  if (!baseline && !unreleasedHasEntries) {
    fail('changelog/unreleased.md has no entries. Describe the changes before releasing.');
  }

  const date = new Date().toLocaleDateString('en-CA');
  const steps = [
    baseline
      ? `use existing changelog/${version}.md`
      : `move changelog/unreleased.md to changelog/${version}.md (dated ${date}) and add it to CHANGELOG.md`,
    `set package.json version to ${version}`,
    `commit "Release ${version}"`,
    `create annotated tag ${tag}`,
  ];
  p.log.info(`${current ? `v${current}` : 'no previous tag'} → ${tag}\n${steps.map((s) => `  - ${s}`).join('\n')}`);

  if (dryRun) {
    p.outro('Dry run: nothing was changed.');
    return;
  }

  if (!assumeYes) {
    const proceed = await p.confirm({ message: `Create release ${tag}?`, initialValue: true });
    if (p.isCancel(proceed) || !proceed) {
      p.cancel('Cancelled.');
      process.exit(0);
    }
  }

  // Changelog rollover
  if (!baseline) {
    const body = unreleased.replace(/^# Unreleased\s*$/m, `# [${version}] - ${date}`);
    await writeFile(releaseFile, body);
    await writeFile(UNRELEASED_PATH, UNRELEASED_TEMPLATE);

    const index = await readFile(INDEX_PATH, 'utf8');
    const marker = '- [Unreleased](changelog/unreleased.md)';
    if (!index.includes(marker)) fail('CHANGELOG.md is missing the Unreleased link; cannot add the new release.');
    await writeFile(INDEX_PATH, index.replace(marker, `${marker}\n- [${version}](changelog/${version}.md) - ${date}`));
  }

  // Version
  const pkg = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));
  pkg.version = version;
  await writeFile(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`);

  git('add', 'CHANGELOG.md', 'changelog', 'package.json');
  git('commit', '-m', `Release ${version}`);
  git('tag', '-a', tag, '-m', `Release ${version}`);

  p.outro(`Created ${tag}. Review, then publish with: git push --follow-tags`);
}

main().catch((err) => {
  p.log.error(String(err));
  process.exit(1);
});
