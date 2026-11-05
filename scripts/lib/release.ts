import { execFileSync } from 'child_process';
import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { REPO_ROOT, pathExists } from './cli.ts';

const CHANGELOG_DIR = join(REPO_ROOT, 'changelog');
const INDEX_PATH = join(REPO_ROOT, 'CHANGELOG.md');
const UNRELEASED_PATH = join(CHANGELOG_DIR, 'unreleased.md');
const PACKAGE_PATH = join(REPO_ROOT, 'package.json');
const RELEASE_BRANCH = 'master';
const BUMPS = ['patch', 'minor', 'major'];
const SEMVER = /^\d+\.\d+\.\d+$/;

export const UNRELEASED_TEMPLATE = `# Unreleased

<!-- One line per user-visible change, added in the same commit as the change.
Group under Added / Changed / Deprecated / Removed / Fixed / Security.
Breaking changes need a **Migration** note. -->
`;

export function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: REPO_ROOT, encoding: 'utf8' }).trim();
}

export function latestTagVersion(): string | null {
  try {
    return git('describe', '--tags', '--abbrev=0', '--match', 'v*').slice(1);
  } catch {
    return null;
  }
}

export function nextVersion(current: string, bump: string): string {
  const [major = 0, minor = 0, patch = 0] = current.split('.').map(Number);
  if (bump === 'major') return `${major + 1}.0.0`;
  if (bump === 'minor') return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

export function hasEntries(markdown: string): boolean {
  const withoutComments = markdown.replace(/<!--[\s\S]*?-->/g, '');
  return /^\s*[-*]\s+\S/m.test(withoutComments);
}

// A changelog entry with a **Migration** note says existing vaults need steps. Sync can run those steps itself
// (migrations/<version>.ts), so the release must either ship that file or say the steps are manual with
// <!-- migrations: none --> somewhere in the changelog. Returns an error message, or null when fine.
export function migrationProblem(version: string, changelog: string, hasMigrationFile: boolean): string | null {
  const visible = changelog.replace(/<!--[\s\S]*?-->/g, '');
  if (!/\*\*Migration/i.test(visible)) return null;
  if (hasMigrationFile) return null;
  // The marker must be a comment on its own line, so prose that merely mentions it does not count.
  if (/^[ \t]*<!--\s*migrations:\s*none\s*-->[ \t]*$/im.test(changelog)) return null;
  return `The changelog has a **Migration** entry, but migrations/${version}.ts does not exist. Add the migration (see migrations/README.md), or add <!-- migrations: none --> to the changelog if the steps are manual.`;
}

export interface ReleaseValidation {
  valid: boolean;
  error?: string;
  currentVersion: string | null;
  version: string;
  tag: string;
  baseline: boolean;
  unreleasedHasEntries: boolean;
  date: string;
  steps: string[];
}

export function validateRelease(target: string): ReleaseValidation {
  // Preconditions
  if (git('status', '--porcelain', '--untracked-files=no')) {
    return { valid: false, error: 'Working tree is not clean. Commit or stash changes first.', currentVersion: null, version: '', tag: '', baseline: false, unreleasedHasEntries: false, date: '', steps: [] };
  }
  const branch = git('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== RELEASE_BRANCH) {
    return { valid: false, error: `Releases are cut from ${RELEASE_BRANCH}, but the current branch is ${branch}.`, currentVersion: null, version: '', tag: '', baseline: false, unreleasedHasEntries: false, date: '', steps: [] };
  }

  // Resolve the version
  const current = latestTagVersion();
  let version: string;
  if (BUMPS.includes(target)) {
    if (!current) {
      return { valid: false, error: 'No v* tag exists yet. Pass an explicit version (e.g. 0.1.0) for the first release.', currentVersion: null, version: '', tag: '', baseline: false, unreleasedHasEntries: false, date: '', steps: [] };
    }
    version = nextVersion(current, target);
  } else if (SEMVER.test(target)) {
    version = target;
  } else {
    return { valid: false, error: `"${target}" is not patch, minor, major or an x.y.z version.`, currentVersion: current, version: '', tag: '', baseline: false, unreleasedHasEntries: false, date: '', steps: [] };
  }

  const tag = `v${version}`;
  if (git('tag', '--list', tag)) {
    return { valid: false, error: `Tag ${tag} already exists.`, currentVersion: current, version, tag, baseline: false, unreleasedHasEntries: false, date: '', steps: [] };
  }

  return { valid: true, currentVersion: current, version, tag, baseline: false, unreleasedHasEntries: false, date: '', steps: [] };
}

export async function validateReleaseAsync(target: string): Promise<ReleaseValidation> {
  const validation = validateRelease(target);
  if (!validation.valid) return validation;

  try {
    execFileSync('node', [join(REPO_ROOT, 'scripts', 'state', 'state.ts'), '--check'], { cwd: REPO_ROOT, stdio: 'pipe' });
  } catch (err) {
    const detail = (err as { stderr?: Buffer }).stderr?.toString().trim() ?? '';
    return { ...validation, valid: false, error: `state.json is out of date. Run \`mise run state\`, commit it, then retry.\n${detail}` };
  }

  const unreleased = (await pathExists(UNRELEASED_PATH)) ? await readFile(UNRELEASED_PATH, 'utf8') : '';
  const unreleasedHasEntries = hasEntries(unreleased);

  const releaseFile = join(CHANGELOG_DIR, `${validation.version}.md`);
  const baseline = await pathExists(releaseFile);
  if (baseline && unreleasedHasEntries) {
    return { ...validation, valid: false, error: `changelog/${validation.version}.md already exists and unreleased.md also has entries. Merge them first.`, baseline, unreleasedHasEntries };
  }
  if (!baseline && !unreleasedHasEntries) {
    return { ...validation, valid: false, error: 'changelog/unreleased.md has no entries. Describe the changes before releasing.', baseline, unreleasedHasEntries };
  }

  const changelog = baseline ? await readFile(releaseFile, 'utf8') : unreleased;
  const migration = migrationProblem(validation.version, changelog, await pathExists(join(REPO_ROOT, 'migrations', `${validation.version}.ts`)));
  if (migration) return { ...validation, valid: false, error: migration, baseline, unreleasedHasEntries };

  const date = new Date().toLocaleDateString('en-CA');
  const steps = [
    baseline
      ? `use existing changelog/${validation.version}.md`
      : `move changelog/unreleased.md to changelog/${validation.version}.md (dated ${date}) and add it to CHANGELOG.md`,
    `set package.json version to ${validation.version}`,
    `commit "Release ${validation.version}"`,
    `create annotated tag ${validation.tag}`,
  ];

  return { ...validation, baseline, unreleasedHasEntries, date, steps };
}

export interface ReleaseResult {
  tag: string;
  version: string;
  previousVersion: string | null;
  date: string;
  baseline: boolean;
}

export async function executeRelease(options: { target: string; dryRun?: boolean }): Promise<ReleaseResult> {
  const { target, dryRun = false } = options;
  const validation = await validateReleaseAsync(target);
  if (!validation.valid) {
    throw new Error(validation.error);
  }

  const { currentVersion, version, tag, baseline, date } = validation;

  if (dryRun) {
    return { tag, version, previousVersion: currentVersion, date, baseline };
  }

  // Changelog rollover
  if (!baseline) {
    const unreleased = (await pathExists(UNRELEASED_PATH)) ? await readFile(UNRELEASED_PATH, 'utf8') : '';
    const body = unreleased.replace(/^# Unreleased\s*$/m, `# [${version}] - ${date}`);
    const releaseFile = join(CHANGELOG_DIR, `${version}.md`);
    await writeFile(releaseFile, body);
    await writeFile(UNRELEASED_PATH, UNRELEASED_TEMPLATE);

    const index = await readFile(INDEX_PATH, 'utf8');
    const marker = '- [Unreleased](changelog/unreleased.md)';
    if (!index.includes(marker)) {
      throw new Error('CHANGELOG.md is missing the Unreleased link; cannot add the new release.');
    }
    await writeFile(INDEX_PATH, index.replace(marker, `${marker}\n- [${version}](changelog/${version}.md) - ${date}`));
  }

  // Version
  const pkg = JSON.parse(await readFile(PACKAGE_PATH, 'utf8'));
  pkg.version = version;
  await writeFile(PACKAGE_PATH, `${JSON.stringify(pkg, null, 2)}\n`);

  git('add', 'CHANGELOG.md', 'changelog', 'package.json');
  git('commit', '-m', `Release ${version}`);
  git('tag', '-a', tag, '-m', `Release ${version}`);

  return { tag, version, previousVersion: currentVersion, date, baseline };
}
