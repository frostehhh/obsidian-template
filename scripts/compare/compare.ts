import * as p from '@clack/prompts';
import { resolve } from 'path';
import {
  loadConfig,
  discoverVaults,
  makeVault,
  selectVaults,
  getTemplateVersion,
  renderReport,
  pathExists,
} from '../lib/cli.ts';
import { compareVault } from '../lib/compare.ts';
import type { Vault, VaultReport } from '../lib/types.ts';
import { join } from 'path';

// Usage: compare [vault-name-or-path] [--verbose] [--json] [--check]
async function main() {
  const args = process.argv.slice(2);
  const verbose = args.includes('--verbose');
  const json = args.includes('--json');
  const check = args.includes('--check');
  const target = args.find((a) => !a.startsWith('--'));

  const config = await loadConfig();
  const vaults = await discoverVaults();
  const version = await getTemplateVersion();

  let selected: Vault[];
  if (target) {
    const byName = vaults.find((v) => v.name === target);
    const root = byName ? byName.root : resolve(target);
    if (!(await pathExists(join(root, '.obsidian')))) {
      console.error(`Not an Obsidian vault: ${root}`);
      process.exit(1);
    }
    selected = [byName ?? makeVault(root.split('/').at(-1) ?? root, root)];
  } else {
    p.intro('  compare  —  Obsidian Template Vault');
    selected = await selectVaults({ vaults, defaults: config.defaultVaults ?? [] });
  }

  let allInSync = true;
  const output: VaultReport[] = [];
  for (const vault of selected) {
    const results = await compareVault(vault);
    if (results.some((r) => r.status !== 'in sync')) allInSync = false;
    output.push({ vault, results });
  }

  if (json) {
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
        files: { match: files.match, differs: files.differs, missing: files.missing, extra: files.extra },
      })),
    }));
    console.log(JSON.stringify(payload, null, 2));
  } else {
    console.log(output.map(({ vault, results }) => renderReport(vault, version, results, { verbose })).join('\n\n'));
  }

  if (check && !allInSync) process.exit(1);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
