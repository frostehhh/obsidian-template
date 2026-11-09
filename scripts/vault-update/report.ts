// Read-only. Usage:
//   report <vault> [--to <ref>] [--base <ref>] [--plugins a,b] [--dirs a,b] [--settings a,b] [--data-json|--no-data-json]
//          [--audit] [--all] [--scope] [--json]
import { buildReport, renderReport, scopeOptions } from '../lib/vaultupdate.ts';
import { parseArgs, resolveVault, run, scopeArgs } from './common.ts';

run(async () => {
  const args = parseArgs();
  const vault = await resolveVault(args.positional[0]);
  const report = await buildReport({
    vault,
    to: args.value('--to'),
    base: args.value('--base'),
    scope: scopeArgs(args),
    audit: args.has('--audit'),
  });

  if (args.has('--scope')) {
    const options = await scopeOptions(vault, report);
    if (args.has('--json')) {
      console.log(JSON.stringify({ vault: vault.name, target: report.target, scope: report.scope, options }, null, 2));
      return;
    }
    const s = report.scope;
    console.log(`vault: ${vault.name}   target: ${report.target.version}`);
    console.log(`sources: plugins from ${s.sources.plugins}, dirs from ${s.sources.dirs}, settings from ${s.sources.settings}; syncDataJson: ${s.syncDataJson}`);
    if (s.linkedDirs.length) console.log(`linked dirs (added with their plugin): ${s.linkedDirs.join(', ')}`);
    for (const kind of ['plugin', 'dir', 'setting']) {
      console.log(`\n${kind}s:`);
      for (const o of options.filter((x) => x.key.startsWith(`${kind}:`))) {
        console.log(`  [${o.selected ? 'x' : ' '}] ${o.key.slice(kind.length + 1).padEnd(48)} ${o.label === o.key.slice(kind.length + 1) ? '' : `${o.label}  `}${o.status}${o.linked ? `  (linked to ${o.linked})` : ''}`);
      }
    }
    return;
  }

  console.log(args.has('--json') ? JSON.stringify(report, null, 2) : renderReport(report, { all: args.has('--all') }));
});
