import {
  PLUGIN_DIR_CONDITIONS,
  loadConfig,
  loadVaultConfig,
  discoverPlugins,
  discoverVaults,
  parseConflictPolicy,
} from '../lib/cli.ts';
import { resolveSource, gitSource } from '../lib/source.ts';
import { loadPolicy } from '../lib/policy.ts';
import { writePlanFile, applyPlanFile, appliedToJson, renderApplied, summarizePlan } from '../lib/planfile.ts';
import type { PlannedVault } from '../lib/planfile.ts';
import { executeSync, buildSyncPlan, buildVaultExtras, conflictLabel, describePlan, resolveVaultConfig } from '../lib/sync.ts';
import type { SyncPreReport, SyncPostReport, SyncConflict } from '../lib/sync.ts';
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
    from: value('--from'),
    assume: value('--assume'),
    onConflict: parseConflictPolicy(value('--on-conflict')),
    plan: value('--plan'),
    apply: value('--apply'),
    ignorePin: flags.has('--ignore-pin'),
  };
}

async function main() {
  const args = parseArgs();

  // --apply <file>: run a saved plan exactly as written; refuses if anything changed since it was made.
  if (args.apply) {
    const applied = await applyPlanFile(args.apply, args.onConflict);
    console.log(args.json ? JSON.stringify(appliedToJson(applied), null, 2) : renderApplied(applied));
    if (applied.some((a) => a.conflicts.length > 0)) process.exitCode = 1;
    return;
  }

  const config = await loadConfig();
  const source = resolveSource(args.from);
  const assume = args.assume ? gitSource(args.assume) : undefined;
  const templateVersion = source.label;

  const allPlugins = await discoverPlugins(source);
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

    // A pin keeps the vault within a version range, so each vault can have its own source.
    const pin = (await loadPolicy(vault)).pin;
    return { vault, config: resolved, finalDirs, source: resolveSource(args.from, pin, { ignorePin: args.ignorePin }) };
  }));

  if (args.dryRun || args.plan) {
    const planned: PlannedVault[] = [];
    const output = {
      templateVersion,
      vaults: [] as Array<{
        name: string;
        plugins: Array<{ id: string; name: string; version: string }>;
        directories: string[];
        settings: string[];
        syncDataJson: boolean;
        migrations: string[];
        patches: string[];
        plan: ReturnType<typeof describePlan>;
      }>,
    };

    for (const { vault, config: vaultConfig, finalDirs, source: vaultSource } of vaultPlans) {
      const selectedPlugins = allPlugins.filter((pl) => vaultConfig.pluginIds.includes(pl.id));
      const plan = await buildSyncPlan({
        vaults: [vault],
        plugins: allPlugins,
        pluginIds: vaultConfig.pluginIds,
        dirs: finalDirs,
        settings: vaultConfig.settings,
        syncDataJson: vaultConfig.syncDataJson,
        source: vaultSource,
        assume,
      });
      const extras = await buildVaultExtras(vault, vaultSource, assume);
      planned.push({ vault, source: vaultSource, plan, extras });
      output.vaults.push({
        migrations: extras.migrations,
        patches: Object.keys(extras.patches),
        name: vault.name,
        plugins: selectedPlugins.map((p) => ({ id: p.id, name: p.name, version: p.version })),
        directories: finalDirs,
        settings: vaultConfig.settings,
        syncDataJson: vaultConfig.syncDataJson,
        plan: describePlan(plan),
      });
    }
    if (args.plan) {
      await writePlanFile(args.plan, planned);
      console.log(`Plan written to ${args.plan}. Apply it with: node scripts/agent/sync.ts --apply ${args.plan}`);
      for (const { vault, source: s, plan } of planned) console.log(`  ${vault.name} (template ${s.label}): ${summarizePlan(plan)}`);
      return;
    }
    console.log(JSON.stringify(output, null, 2));
    return;
  }

  // Execute per vault
  const allPreReports: SyncPreReport[] = [];
  const allPostReports: SyncPostReport[] = [];
  const allConflicts: SyncConflict[] = [];
  const allNotes: string[] = [];

  for (const { vault, config: vaultConfig, finalDirs, source: vaultSource } of vaultPlans) {
    const result = await executeSync({
      vaults: [vault],
      plugins: allPlugins,
      pluginIds: vaultConfig.pluginIds,
      dirs: finalDirs,
      settings: vaultConfig.settings,
      syncDataJson: vaultConfig.syncDataJson,
      source: vaultSource,
      assume,
      onConflict: args.onConflict,
    });
    allPreReports.push(...result.preReports);
    allPostReports.push(...result.postReports);
    allConflicts.push(...result.conflicts);
    allNotes.push(...result.notes.map((n) => `${vault.name}: ${n}`));
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
          files: {
            match: files.match,
            differs: files.differs,
            missing: files.missing,
            extra: files.extra,
            overridden: files.overridden,
            stale: files.stale,
          },
        })),
      })),
      conflicts: allConflicts.map((c) => ({ vault: c.vault.name, kind: c.item.kind, id: c.item.id, file: c.file, detail: c.detail })),
      notes: allNotes,
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
    if (allConflicts.length > 0) {
      console.log(`  ${allConflicts.length} conflict(s) left untouched (re-run with --on-conflict take-template|keep-vault):`);
      for (const c of allConflicts) console.log(`      ${c.vault.name}: ${c.item.kind} ${c.item.label}: ${conflictLabel(c)}`);
    }
    for (const note of allNotes) console.log(`  ${note}`);
  }

  if (allConflicts.length > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
