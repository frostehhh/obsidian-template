import { mkdtemp, readFile, rename, rm, writeFile, mkdir, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { pathToFileURL } from 'url';
import { formatLike, mergePatch, deepEqual } from './jsonmerge.ts';
import { compareVersions, parseVersion } from './semver.ts';
import type { Version } from './semver.ts';
import type { Policy } from './policy.ts';
import type { Lock, TemplateSource, Vault } from './types.ts';

// A migration is a file `migrations/<x.y.z>.ts` in the template repo that exports `description` and `run(ctx)`.
// It carries a vault from the previous release to <x.y.z> for things plain file sync cannot express
// (renaming a key inside a plugin's data.json, moving a user's file, ...). It is loaded from the same git ref
// as the template, so syncing a tag always runs that tag's migrations.
//
// Rules: self-contained (only `import type` is allowed), idempotent (running it twice changes nothing more
// than once), and it only touches the vault through ctx. Writes to protected paths are skipped.

export interface MigrationContext {
  // Version of the migration being run
  version: string;
  vaultRoot: string;
  log(message: string): void;
  exists(rel: string): Promise<boolean>;
  readText(rel: string): Promise<string>;
  writeText(rel: string, text: string): Promise<void>;
  readJson(rel: string): Promise<unknown>;
  writeJson(rel: string, value: unknown): Promise<void>;
  // RFC 7386 merge patch applied to a JSON file; false when the file is missing or already patched
  patchJson(rel: string, patch: unknown): Promise<boolean>;
  rename(from: string, to: string): Promise<void>;
  remove(rel: string): Promise<void>;
}

export interface Migration {
  description: string;
  run(ctx: MigrationContext): Promise<void> | void;
}

const FILE = /^(\d+\.\d+\.\d+)\.ts$/;

export const MIGRATIONS_DIR = 'migrations';

// Migration versions in the source, oldest first.
export async function listMigrations(source: TemplateSource): Promise<string[]> {
  const versions: string[] = [];
  for (const name of await source.listRepo(MIGRATIONS_DIR)) {
    const m = FILE.exec(name);
    if (m?.[1]) versions.push(m[1]);
  }
  return versions.sort((a, b) => compareVersions(ver(a), ver(b)));
}

// Versions here come from file names matching FILE, so they always parse.
function ver(version: string): Version {
  return parseVersion(version) as Version;
}

export interface MigrationPlan {
  // Run these, in order
  pending: string[];
  // Written to the lock after a successful run (pending plus those that were already applied or are covered by the baseline)
  record: string[];
}

// Which migrations a vault still needs, from its lock.
//   - A lock that records migrations is authoritative: everything not recorded and not newer than the target is pending.
//   - Otherwise the baseline is the oldest version any item was synced from (or --assume for an untracked vault);
//     migrations at or below it are considered done. With no baseline at all (a fresh vault) nothing is pending.
export function planMigrations(
  available: string[],
  lock: Lock | null,
  assumeVersion: string | undefined,
  target: string
): MigrationPlan {
  const upper = parseVersion(target); // null for working-tree: no upper bound
  const inRange = available.filter((v) => !upper || compareVersions(ver(v), upper) <= 0);

  if (lock?.migrations) {
    const applied = new Set(lock.migrations);
    const pending = inRange.filter((v) => !applied.has(v));
    return { pending, record: [...lock.migrations, ...pending] };
  }

  let baseline = assumeVersion ? parseVersion(assumeVersion) : null;
  if (lock) {
    const versions = Object.values(lock.items)
      .map((item) => parseVersion(item.templateVersion))
      .filter((v): v is NonNullable<typeof v> => v !== null)
      .sort(compareVersions);
    baseline = versions[0] ?? null;
  }
  if (!baseline) return { pending: [], record: inRange };

  const done = inRange.filter((v) => compareVersions(ver(v), baseline) <= 0);
  const pending = inRange.filter((v) => !done.includes(v));
  return { pending, record: [...done, ...pending] };
}

// Loads a migration's code from the source. The file is written to a temp directory and imported.
async function loadMigration(source: TemplateSource, version: string): Promise<Migration> {
  const code = await source.readRepo(`${MIGRATIONS_DIR}/${version}.ts`);
  const dir = await mkdtemp(join(tmpdir(), 'sync-migration-'));
  try {
    const file = join(dir, `${version}.ts`);
    await writeFile(file, code);
    const mod = (await import(pathToFileURL(file).href)) as { default?: Partial<Migration>; run?: Migration['run']; description?: string };
    const run = mod.default?.run ?? mod.run;
    if (typeof run !== 'function') throw new Error(`migrations/${version}.ts must export run(ctx)`);
    return { description: mod.default?.description ?? mod.description ?? '', run };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function createContext(vault: Vault, version: string, policy: Policy, log: (line: string) => void): MigrationContext {
  const root = resolve(vault.root);
  function abs(rel: string): string {
    const full = resolve(root, rel);
    const inside = relative(root, full);
    if (!inside || inside.startsWith('..') || isAbsolute(inside)) throw new Error(`Migration ${version}: path escapes the vault: ${rel}`);
    return full;
  }
  const protectedPath = (rel: string) => policy.isProtected(relative(root, abs(rel)).split('\\').join('/'));
  const say = (message: string) => log(`[${version}] ${message}`);

  async function exists(rel: string): Promise<boolean> {
    try {
      await stat(abs(rel));
      return true;
    } catch {
      return false;
    }
  }
  async function writeAtomic(rel: string, text: string): Promise<void> {
    const target = abs(rel);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.sync-tmp`;
    await writeFile(tmp, text);
    await rename(tmp, target);
  }

  return {
    version,
    vaultRoot: root,
    log: say,
    exists,
    readText: (rel) => readFile(abs(rel), 'utf8'),
    async writeText(rel, text) {
      if (protectedPath(rel)) return say(`skipped ${rel} (protected)`);
      await writeAtomic(rel, text);
    },
    readJson: async (rel) => JSON.parse(await readFile(abs(rel), 'utf8')),
    async writeJson(rel, value) {
      if (protectedPath(rel)) return say(`skipped ${rel} (protected)`);
      let sample = '';
      try {
        sample = await readFile(abs(rel), 'utf8');
      } catch {
        // new file
      }
      await writeAtomic(rel, formatLike(sample || '{}\n', value));
    },
    async patchJson(rel, patch) {
      if (!(await exists(rel))) return false;
      if (protectedPath(rel)) {
        say(`skipped ${rel} (protected)`);
        return false;
      }
      const text = await readFile(abs(rel), 'utf8');
      const current: unknown = JSON.parse(text);
      const next = mergePatch(current, patch);
      if (deepEqual(current, next)) return false;
      await writeAtomic(rel, formatLike(text, next));
      return true;
    },
    async rename(from, to) {
      if (!(await exists(from))) return;
      if (protectedPath(from) || protectedPath(to)) return say(`skipped rename ${from} -> ${to} (protected)`);
      if (await exists(to)) return say(`skipped rename ${from} -> ${to} (target exists)`);
      await mkdir(dirname(abs(to)), { recursive: true });
      await rename(abs(from), abs(to));
    },
    async remove(rel) {
      if (protectedPath(rel)) return say(`skipped remove ${rel} (protected)`);
      await rm(abs(rel), { recursive: true, force: true });
    },
  };
}

// Applies the vault's `patches` (JSON merge patches by vault-relative path). Idempotent: files that already match
// are left alone, missing files are skipped, protected paths are never written.
export async function applyPatches(vault: Vault, patches: Record<string, unknown>, policy: Policy): Promise<string[]> {
  const lines: string[] = [];
  const ctx = createContext(vault, 'patches', policy, (line) => lines.push(line));
  for (const [rel, patch] of Object.entries(patches)) {
    if (await ctx.patchJson(rel, patch)) lines.push(`[patches] patched ${rel}`);
  }
  return lines;
}

// Runs migrations in order against a vault. Returns the log lines they produced.
export async function runMigrations(vault: Vault, versions: string[], source: TemplateSource, policy: Policy): Promise<string[]> {
  const lines: string[] = [];
  for (const version of versions) {
    const migration = await loadMigration(source, version);
    lines.push(`[${version}] ${migration.description || 'running'}`);
    await migration.run(createContext(vault, version, policy, (line) => lines.push(line)));
  }
  return lines;
}
