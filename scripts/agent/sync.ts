import {
  PLUGIN_DIR_CONDITIONS,
  loadConfig,
  loadVaultConfig,
  discoverPlugins,
  discoverVaults,
  getTemplateVersion,
} from '../lib/cli.ts';
import { executeSync, buildSyncPlan, resolveVaultConfig } from '../lib/sync.ts';
import type { SyncPreReport, SyncPostReport } from '../lib/sync.ts';
import type { Vault } from '../lib/types.ts';

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
    plugins: list('--plugins'),
    dirs: list('--dirs'),
    settings: list('--settings'),
    dataJson: flags.has('--data-json'),
    json: flags.has('--json'),
    dryRun: flags.has('--dry-run'),
  };
}

async function main() {
  const args = parseArgs();
  const config = await loadConfig();
  const templateVersion = await getTemplateVersion();

  const allPlugins = await discoverPlugins();
  const allVaults = await discoverVaults();

  // Resolve vaults
  let selectedVaults: Vault[];
  if (args.vaults) {
    selectedVaults = [];
    for (const name of args.vaults) {
      const found = allVaults.find((v) => v.name === name);
      if (found) {
        selectedVaults.push(found);
      } else {
        console.error(`Vault not found: ${name}`);
        process.exit(1);
      }
    }
  } else if (config.defaultVaults && config.defaultVaults.length > 0) {
    selectedVaults = allVaults.filter((v) => config.defaultVaults!.includes(v.name));
  } else {
    selectedVaults = allVaults;
  }

  if (selectedVaults.length === 0) {
    console.error('No target vaults found.');
    process.exit(1);
  }

  // Resolve per-vault configuration
  const vaultPlans = await Promise.all(selectedVaults.map(async (vault) => {
    const vaultConfig = await loadVaultConfig(vault.root);
    const resolved = resolveVaultConfig(vaultConfig, config, {
      plugins: args.plugins,
      dirs: args.dirs,
      settings: args.settings,
      dataJson: args.dataJson,
    });

    const unknown = resolved.pluginIds.filter((id) => !allPlugins.find((p) => p.id === id));
    if (unknown.length > 0) {
      console.error(`Vault ${vault.name}: unknown plugin(s): ${unknown.join(', ')}`);
      process.exit(1);
    }

    const autoDirs = PLUGIN_DIR_CONDITIONS
      .filter((c) => resolved.pluginIds.includes(c.pluginId))
      .map((c) => c.dir);
    const finalDirs = [...new Set([...resolved.dirs, ...autoDirs])];

    return { vault, config: resolved, finalDirs };
  }));

  if (args.dryRun) {
    const output = {
      templateVersion,
      vaults: [] as Array<{
        name: string;
        plugins: Array<{ id: string; name: string; version: string }>;
        directories: string[];
        settings: string[];
        syncDataJson: boolean;
        plan: Array<{
          plugin: string;
          filesToCopy: string[];
          filesToSkip: string[];
          subDirs: string[];
          addToCommunityPlugins: boolean;
        }>;
      }>,
    };

    for (const { vault, config: vaultConfig, finalDirs } of vaultPlans) {
      const selectedPlugins = allPlugins.filter((pl) => vaultConfig.pluginIds.includes(pl.id));
      const plan = await buildSyncPlan({
        vaults: [vault],
        plugins: allPlugins,
        pluginIds: vaultConfig.pluginIds,
        dirs: finalDirs,
        settings: vaultConfig.settings,
        syncDataJson: vaultConfig.syncDataJson,
      });
      output.vaults.push({
        name: vault.name,
        plugins: selectedPlugins.map((p) => ({ id: p.id, name: p.name, version: p.version })),
        directories: finalDirs,
        settings: vaultConfig.settings,
        syncDataJson: vaultConfig.syncDataJson,
        plan: plan.map((e) => ({
          plugin: e.plugin.id,
          filesToCopy: e.filesToCopy,
          filesToSkip: e.filesToSkip,
          subDirs: e.subDirs,
          addToCommunityPlugins: e.addToCommunityPlugins,
        })),
      });
    }
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Execute per vault
  const allPreReports: SyncPreReport[] = [];
  const allPostReports: SyncPostReport[] = [];

  for (const { vault, config: vaultConfig, finalDirs } of vaultPlans) {
    const result = await executeSync({
      vaults: [vault],
      plugins: allPlugins,
      pluginIds: vaultConfig.pluginIds,
      dirs: finalDirs,
      settings: vaultConfig.settings,
      syncDataJson: vaultConfig.syncDataJson,
    });
    allPreReports.push(...result.preReports);
    allPostReports.push(...result.postReports);
  }

  if (args.json) {
    console.log(JSON.stringify({
      templateVersion,
      preSync: allPreReports.map((r) => ({
        vault: r.vault.name,
        inSync: r.inSync,
        total: r.total,
      })),
      postSync: allPostReports.map(({ vault, results }) => ({
        vault: vault.name,
        allMatch: results.every((r) => r.status === 'in sync'),
        items: results.map(({ kind, id, label, status, templateVersion, vaultVersion, files }) => ({
          kind,
          id,
          label,
          status,
          templateVersion,
          vaultVersion,
          files: { match: files.match, differs: files.differs, missing: files.missing, extra: files.extra },
        })),
      })),
    }, null, 2));
  } else {
    console.log(`Synced across ${selectedVaults.length} vault(s):`);
    for (const { vault, config: vaultConfig, finalDirs } of vaultPlans) {
      console.log(`  ${vault.name}: ${vaultConfig.pluginIds.length} plugin(s), ${finalDirs.length} director${finalDirs.length === 1 ? 'y' : 'ies'}, ${vaultConfig.settings.length} setting(s)`);
    }
    for (const { vault, results } of allPostReports) {
      const notMatching = results.filter((r) => r.status !== 'in sync');
      if (notMatching.length === 0) {
        console.log(`  ✓ ${vault.name}: all ${results.length} synced item(s) match the template.`);
      } else {
        console.log(`  ✗ ${vault.name}: ${notMatching.length} item(s) do not match:`);
        for (const r of notMatching) {
          console.log(`      ${r.kind} ${r.label}: ${r.status}`);
        }
      }
    }
  }
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
