import { stat } from 'fs/promises';
import { basename, join, resolve } from 'path';
import { discoverVaults, makeVault } from '../lib/cli.ts';
import type { ScopeArgs } from '../lib/vaultupdate.ts';
import type { Vault } from '../lib/types.ts';

export interface Args {
  positional: string[];
  has(flag: string): boolean;
  value(flag: string): string | undefined;
  values(flag: string): string[];
  list(flag: string): string[] | undefined;
}

const BOOLEAN = new Set(['--json', '--all', '--audit', '--scope', '--dry-run', '--save-scope', '--data-json', '--no-data-json']);

export function parseArgs(argv = process.argv.slice(2)): Args {
  const positional: string[] = [];
  const pairs: Array<[string, string | undefined]> = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === '--') continue;
    if (!arg.startsWith('--')) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf('=');
    if (eq > 0) {
      pairs.push([arg.slice(0, eq), arg.slice(eq + 1)]);
    } else if (BOOLEAN.has(arg)) {
      pairs.push([arg, undefined]);
    } else {
      pairs.push([arg, argv[i + 1]]);
      i += 1;
    }
  }
  const values = (flag: string) => pairs.filter(([f]) => f === flag).map(([, v]) => v).filter((v): v is string => v !== undefined);
  return {
    positional,
    has: (flag) => pairs.some(([f]) => f === flag),
    value: (flag) => values(flag).at(-1),
    values,
    list(flag) {
      const v = values(flag);
      return v.length ? v.flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean) : undefined;
    },
  };
}

export function scopeArgs(args: Args): ScopeArgs {
  const scope: ScopeArgs = {};
  const plugins = args.list('--plugins');
  const dirs = args.list('--dirs');
  const settings = args.list('--settings');
  if (plugins) scope.plugins = plugins;
  if (dirs) scope.dirs = dirs;
  if (settings) scope.settings = settings;
  if (args.has('--data-json')) scope.dataJson = true;
  if (args.has('--no-data-json')) scope.dataJson = false;
  return scope;
}

// A sibling vault name or a path to a vault.
export async function resolveVault(target: string | undefined): Promise<Vault> {
  if (!target) throw new Error('Name the vault: <vault-name-or-path>');
  const found = (await discoverVaults()).find((v) => v.name === target);
  if (found) return found;
  const root = resolve(target);
  try {
    await stat(join(root, '.obsidian'));
  } catch {
    throw new Error(`Not a vault (no .obsidian/): ${target}`);
  }
  return makeVault(basename(root), root);
}

export function run(main: () => Promise<void>): void {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
