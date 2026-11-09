// The only writer of the v2 lock. Usage:
//   record <vault> --commit <ref> [--keep <id>]... [--defer <id>]... [--decline <key>[=label]]... [--drop-decline <key>]...
//          [--decisions <file>] [--save-scope] [--base <ref>] [scope flags] [--dry-run] [--json]
//   record <vault> --save-scope [scope flags]        (writes only defaultPlugins/defaultDirs/defaultSettings)
import { copyFile, readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { formatLike } from '../lib/jsonmerge.ts';
import { LOCK_V1_BACKUP, lockPath, readLockFile, saveLockV2, serializeLockV2 } from '../lib/lock.ts';
import { buildReport, checkDecisions } from '../lib/vaultupdate.ts';
import type { Decisions } from '../lib/vaultupdate.ts';
import type { LockV2, SyncConfig } from '../lib/types.ts';
import { parseArgs, resolveVault, run, scopeArgs } from './common.ts';

async function readDecisions(file: string | undefined): Promise<Decisions> {
  const d: Decisions = { keep: [], defer: [], decline: {} };
  if (!file) return d;
  const raw = JSON.parse(await readFile(file, 'utf8')) as { keep?: string[]; defer?: string[]; decline?: string[] | Record<string, string> };
  d.keep = raw.keep ?? [];
  d.defer = raw.defer ?? [];
  d.decline = Array.isArray(raw.decline) ? Object.fromEntries(raw.decline.map((k) => [k, ''])) : (raw.decline ?? {});
  return d;
}

run(async () => {
  const args = parseArgs();
  const vault = await resolveVault(args.positional[0]);
  const commit = args.value('--commit');
  const dryRun = args.has('--dry-run');
  if (!commit && !args.has('--save-scope')) throw new Error('Pass --commit <ref> (the target you updated to), or --save-scope.');

  const decisions = await readDecisions(args.value('--decisions'));
  decisions.keep.push(...args.values('--keep'));
  decisions.defer.push(...args.values('--defer'));
  for (const raw of args.values('--decline')) {
    const eq = raw.lastIndexOf('=');
    const hasLabel = eq > 0 && !raw.slice(eq).includes('/') && !raw.slice(eq).includes('#');
    decisions.decline[hasLabel ? raw.slice(0, eq) : raw] = hasLabel ? raw.slice(eq + 1) : '';
  }
  const dropDeclines = args.values('--drop-decline');

  const report = await buildReport({ vault, to: commit, base: args.value('--base'), scope: scopeArgs(args) });

  const configPath = join(vault.root, '.obsidian', 'sync.config.json');
  let configText: string | null = null;
  try {
    configText = await readFile(configPath, 'utf8');
  } catch {
    configText = null;
  }
  const config = (configText ? JSON.parse(configText) : {}) as SyncConfig;
  const original = JSON.stringify(config);
  const changes: string[] = [];

  if (args.has('--save-scope')) {
    config.defaultPlugins = report.scope.plugins;
    config.defaultDirs = report.scope.dirs;
    config.defaultSettings = report.scope.settings;
    changes.push(`scope saved: ${report.scope.plugins.length} plugins, ${report.scope.dirs.length} dirs, ${report.scope.settings.length} settings`);
  }

  let lock: LockV2 | null = null;
  if (commit) {
    const check = checkDecisions(report.entries, decisions, report.base?.version ?? 'unknown');
    for (const key of dropDeclines) if (!config.decline || !(key in config.decline)) check.problems.push(`--drop-decline ${key}: not in the vault config`);
    if (check.problems.length) {
      process.exitCode = 1;
      console.error(`Refused, nothing written. ${check.problems.length} problem(s):\n  ${check.problems.join('\n  ')}`);
      return;
    }
    if (Object.keys(check.declines).length || dropDeclines.length) {
      const decline = { ...(config.decline ?? {}), ...check.declines };
      for (const key of dropDeclines) delete decline[key];
      config.decline = decline;
      for (const [key, label] of Object.entries(check.declines)) changes.push(`declined ${key} ("${label}")`);
      for (const key of dropDeclines) changes.push(`dropped decline ${key}`);
    }
    if (!config.decline || Object.keys(config.decline).length === 0) delete config.decline;
    lock = {
      lockVersion: 2,
      commit: report.target.commit,
      version: report.target.version,
      items: report.scope.items,
      pending: check.pending,
    };
    for (const id of check.kept) changes.push(`kept vault version of ${id}`);
    for (const id of Object.keys(check.pending)) changes.push(`deferred ${id}`);
  }

  const newConfig = configText ? formatLike(configText, config) : `${JSON.stringify(config, null, 2)}\n`;
  const configChanged = JSON.stringify(config) !== original;
  const previous = await readLockFile(vault);

  if (!dryRun) {
    if (configChanged) await writeFile(configPath, newConfig);
    if (lock) {
      if (previous?.lockVersion === 1) {
        const backup = join(vault.root, '.obsidian', LOCK_V1_BACKUP);
        let exists = true;
        try {
          await readFile(backup);
        } catch {
          exists = false;
        }
        if (!exists) {
          await copyFile(lockPath(vault), backup);
          changes.push(`v1 lock backed up to .obsidian/${LOCK_V1_BACKUP}`);
        }
      }
      await saveLockV2(vault, lock);
    }
  }

  const from = previous ? (previous.lockVersion === 2 ? `v2 ${previous.version}` : 'v1') : 'none';
  const summary = {
    vault: vault.name,
    dryRun,
    lock: lock ? { from, to: `v2 ${lock.version} (${lock.commit.slice(0, 7)})` } : null,
    configChanged,
    changes,
    ...(dryRun && lock ? { lockFile: serializeLockV2(lock) } : {}),
  };
  if (args.has('--json')) console.log(JSON.stringify(summary, null, 2));
  else {
    console.log(`${dryRun ? 'Would record' : 'Recorded'} ${vault.name}${lock ? `: lock ${summary.lock?.from} -> ${summary.lock?.to}` : ''}${configChanged ? ', sync.config.json updated' : ''}`);
    for (const c of changes) console.log(`  ${c}`);
  }
});
