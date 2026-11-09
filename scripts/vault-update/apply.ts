// Writes the template side of chosen entries into the vault. Never touches the lock or the vault config. Usage:
//   apply <vault> (--entry <id>... | --all) [--take-template <id>...] [--to <ref>] [--base <ref>] [scope flags] [--dry-run] [--json]
// --all: every entry in state apply, apply (auto) or apply (no base). Conflicts are written only when listed with --take-template.
import { mkdir, readFile, readdir, rm, rmdir, writeFile } from 'fs/promises';
import { dirname, join } from 'path';
import { formatLike } from '../lib/jsonmerge.ts';
import { ABSENT, buildReport, getAt, parseKey, readBlob, setAt, treeAt } from '../lib/vaultupdate.ts';
import type { Entry } from '../lib/vaultupdate.ts';
import { parseArgs, resolveVault, run, scopeArgs } from './common.ts';

const APPLY_STATES = new Set(['apply', 'apply-auto', 'apply-nobase']);

async function removeFile(root: string, rel: string): Promise<void> {
  await rm(join(root, rel), { force: true });
  let dir = dirname(rel);
  while (dir && dir !== '.') {
    try {
      if ((await readdir(join(root, dir))).length > 0) return;
      await rmdir(join(root, dir));
    } catch {
      return;
    }
    dir = dirname(dir);
  }
}

run(async () => {
  const args = parseArgs();
  const vault = await resolveVault(args.positional[0]);
  const report = await buildReport({ vault, to: args.value('--to'), base: args.value('--base'), scope: scopeArgs(args) });
  const byId = new Map(report.entries.map((e) => [e.id, e]));
  const takeTemplate = new Set(args.values('--take-template'));
  const requested = args.has('--all')
    ? [...report.entries.filter((e) => APPLY_STATES.has(e.state)).map((e) => e.id), ...takeTemplate]
    : [...args.values('--entry'), ...takeTemplate];
  if (requested.length === 0) throw new Error('Nothing to apply. Pass --entry <id> (repeatable), --take-template <id> or --all.');

  const problems: string[] = [];
  const selected: Entry[] = [];
  for (const id of new Set(requested)) {
    const e = byId.get(id);
    if (!e) problems.push(`${id}: not in the report`);
    else if (e.state === 'done') continue;
    else if (e.state === 'conflict' && !takeTemplate.has(id)) problems.push(`${id}: conflict, pass --take-template to overwrite the vault's version`);
    else if (e.state !== 'conflict' && !APPLY_STATES.has(e.state)) problems.push(`${id}: ${e.state}, not applied`);
    else selected.push(e);
  }
  if (problems.length) throw new Error(`Refused, nothing written:\n  ${problems.join('\n  ')}`);

  const tree = treeAt(report.target.commit);
  const actions: string[] = [];
  const dryRun = args.has('--dry-run');
  const enable = new Set<string>();

  for (const e of selected.filter((x) => x.key === undefined)) {
    const dest = join(vault.root, e.path);
    if (e.new === ABSENT) {
      actions.push(`delete ${e.path}`);
      if (!dryRun) await removeFile(vault.root, e.path);
    } else {
      const content = readBlob(e.new);
      if (!content) throw new Error(`Blob ${e.new} for ${e.path} is missing from the repo`);
      actions.push(`${e.change === 'rename' ? `move ${e.from} ->` : e.change === 'add' ? 'add' : 'write'} ${e.path}`);
      if (!dryRun) {
        await mkdir(dirname(dest), { recursive: true });
        await writeFile(dest, content);
        if (e.from) await removeFile(vault.root, e.from);
      }
      const plugin = /^\.obsidian\/plugins\/([^/]+)\/manifest\.json$/.exec(e.path);
      if (plugin && e.vault === ABSENT) enable.add(plugin[1] as string);
    }
  }

  const keyed = new Map<string, Entry[]>();
  for (const e of selected.filter((x) => x.key !== undefined)) keyed.set(e.path, [...(keyed.get(e.path) ?? []), e]);
  for (const [path, list] of keyed) {
    const sha = tree.get(path);
    const templateDoc = sha ? JSON.parse((readBlob(sha) ?? '').toString()) : undefined;
    const text = await readFile(join(vault.root, path), 'utf8');
    let doc: unknown = JSON.parse(text);
    for (const e of list) {
      const segs = parseKey(e.key as string);
      const value = getAt(templateDoc, segs);
      doc = setAt(doc, segs, value);
      actions.push(`${value === undefined ? 'remove' : 'set'} ${path} ${e.key}${e.label ? ` ("${e.label}")` : ''}`);
    }
    if (!dryRun) await writeFile(join(vault.root, path), formatLike(text, doc));
  }

  if (enable.size) {
    const file = join(vault.root, '.obsidian', 'community-plugins.json');
    let text = '[]\n';
    try {
      text = await readFile(file, 'utf8');
    } catch {
      // created below
    }
    const list = JSON.parse(text) as string[];
    const added = [...enable].filter((id) => !list.includes(id));
    if (added.length) {
      actions.push(`enable ${added.join(', ')} in community-plugins.json`);
      if (!dryRun) await writeFile(file, formatLike(text, [...list, ...added]));
    }
  }

  if (args.has('--json')) console.log(JSON.stringify({ vault: vault.name, target: report.target, dryRun, actions }, null, 2));
  else console.log(`${dryRun ? 'Would apply' : 'Applied'} ${selected.length} entr${selected.length === 1 ? 'y' : 'ies'} to ${vault.name} (target ${report.target.version}):\n  ${actions.join('\n  ')}`);
});
