import {
  PLUGIN_DIR_CONDITIONS,
  loadConfig,
  discoverPlugins,
  discoverVaults,
  getTemplateVersion,
} from '../lib/cli.ts';
import { executeSync, buildSyncPlan } from '../lib/sync.ts';
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

  // Resolve plugins
  let selectedPluginIds: string[];
  if (args.plugins) {
    selectedPluginIds = args.plugins;
    const unknown = selectedPluginIds.filter((id) => !allPlugins.find((p) => p.id === id));
    if (unknown.length > 0) {
      console.error(`Unknown plugin(s): ${unknown.join(', ')}`);
      process.exit(1);
    }
  } else {
    selectedPluginIds = config.defaultPlugins ?? [];
  }

  if (selectedPluginIds.length === 0) {
    console.error('No plugins selected. Use --plugins or set defaultPlugins in sync.config.json.');
    process.exit(1);
  }

  // Resolve directories
  let selectedDirs: string[];
  if (args.dirs) {
    selectedDirs = args.dirs;
  } else {
    selectedDirs = config.defaultDirs ?? ['--Attachments--', '--Configurations--/Obsidian Template', 'Bases', 'Notes'];
  }

  // Auto-include plugin-linked directories
  const autoDirs = PLUGIN_DIR_CONDITIONS
    .filter((c) => selectedPluginIds.includes(c.pluginId))
    .map((c) => c.dir);
  const finalDirs = [...new Set([...selectedDirs, ...autoDirs])];

  // Resolve settings
  let selectedSettings: string[];
  if (args.settings) {
    selectedSettings = args.settings;
  } else {
    selectedSettings = config.defaultSettings ?? [];
  }

  const syncDataJson = args.dataJson || (config.syncDataJson ?? false);
  const selectedPlugins = allPlugins.filter((pl) => selectedPluginIds.includes(pl.id));

  if (args.dryRun) {
    const plan = await buildSyncPlan({
      vaults: selectedVaults,
      plugins: allPlugins,
      pluginIds: selectedPluginIds,
      dirs: finalDirs,
      settings: selectedSettings,
      syncDataJson,
    });
    const output = {
      templateVersion,
      vaults: selectedVaults.map((v) => v.name),
      plugins: selectedPlugins.map((p) => ({ id: p.id, name: p.name, version: p.version })),
      directories: finalDirs,
      settings: selectedSettings,
      syncDataJson,
      plan: plan.map((e) => ({
        vault: e.vault.name,
        plugin: e.plugin.id,
        filesToCopy: e.filesToCopy,
        filesToSkip: e.filesToSkip,
        subDirs: e.subDirs,
        addToCommunityPlugins: e.addToCommunityPlugins,
      })),
    };
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  const result = await executeSync({
    vaults: selectedVaults,
    plugins: allPlugins,
    pluginIds: selectedPluginIds,
    dirs: finalDirs,
    settings: selectedSettings,
    syncDataJson,
  });

  if (args.json) {
    console.log(JSON.stringify({
      templateVersion,
      preSync: result.preReports.map((r) => ({
        vault: r.vault.name,
        inSync: r.inSync,
        total: r.total,
      })),
      postSync: result.postReports.map(({ vault, results }) => ({
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
    console.log(`Synced ${selectedPlugins.length} plugin(s), ${finalDirs.length} director${finalDirs.length === 1 ? 'y' : 'ies'}, and ${selectedSettings.length} setting(s) across ${selectedVaults.length} vault(s).`);
    for (const { vault, results } of result.postReports) {
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
