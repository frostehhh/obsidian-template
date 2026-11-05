import * as p from '@clack/prompts';
import { resolve } from 'path';
import { join } from 'path';
import {
  loadConfig,
  discoverVaults,
  makeVault,
  selectVaults,
  renderReport,
  pathExists,
} from '../lib/cli.ts';
import { compareVault } from '../lib/compare.ts';
import { resolveSource } from '../lib/source.ts';
import type { Vault, VaultReport } from '../lib/types.ts';

function parseArgs() {
  const args = process.argv.slice(2);
  const flags = new Set<string>();
  const flagValues = new Set<string>();

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg && arg.startsWith('--')) {
      flags.add(arg);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flagValues.add(next);
      }
    }
  }

  function value(flag: string): string | undefined {
    const i = args.indexOf(flag);
    const next = i >= 0 ? args[i + 1] : undefined;
    return next && !next.startsWith('--') ? next : undefined;
  }

  function list(flag: string): string[] | undefined {
    const v = value(flag);
    return v ? v.split(',').map((s) => s.trim()).filter(Boolean) : undefined;
  }

  return {
    vaults: list('--vaults'),
    target: args.find((a) => !a.startsWith('--') && !flagValues.has(a)),
    verbose: flags.has('--verbose'),
    json: flags.has('--json'),
    check: flags.has('--check'),
    from: value('--from'),
  };
}

// Usage: compare [vault-name-or-path] [--verbose] [--json] [--check]
//                or: compare --vaults Vault1,Vault2 [--verbose] [--json] [--check]
async function main() {
  const args = parseArgs();
  const config = await loadConfig();
  const vaults = await discoverVaults();
  const source = resolveSource(args.from);
  const version = source.label;

  let selected: Vault[];
  if (args.target) {
    const byName = vaults.find((v) => v.name === args.target);
    const root = byName ? byName.root : resolve(args.target);
    if (!(await pathExists(join(root, '.obsidian')))) {
      console.error(`Not an Obsidian vault: ${root}`);
      process.exit(1);
    }
    selected = [byName ?? makeVault(root.split('/').at(-1) ?? root, root)];
  } else if (args.vaults) {
    selected = [];
    for (const name of args.vaults) {
      const found = vaults.find((v) => v.name === name);
      if (found) {
        selected.push(found);
      } else {
        console.error(`Vault not found: ${name}`);
        process.exit(1);
      }
    }
  } else {
    p.intro('  compare  —  Obsidian Template Vault');
    selected = await selectVaults({ vaults, defaults: config.defaultVaults ?? [] });
  }

  if (selected.length === 0) {
    console.error('No vaults selected.');
    process.exit(1);
  }

  let allInSync = true;
  const output: VaultReport[] = [];
  for (const vault of selected) {
    const results = await compareVault(vault, source);
    if (results.some((r) => r.status !== 'in sync')) allInSync = false;
    output.push({ vault, results });
  }

  if (args.json) {
    const payload = output.map(({ vault, results }) => ({
      vault: vault.name,
      root: vault.root,
      templateVersion: version,
      items: results.map(({ kind, id, status, templateVersion, vaultVersion, files }) => ({
        kind,
        id,
        status,
        templateVersion,
        vaultVersion,
        files: {
          match: files.match,
          differs: files.differs,
          missing: files.missing,
          extra: files.extra,
          overridden: files.overridden,
          stale: files.stale,
        },
      })),
    }));
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(output.map(({ vault, results }) => renderReport(vault, version, results, { verbose: args.verbose })).join('\n\n'));
  }

  if (args.check && !allInSync) process.exit(1);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
