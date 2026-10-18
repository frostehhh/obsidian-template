import { readdir, readFile, writeFile, stat } from 'fs/promises';
import { join } from 'path';
import {
  STATE,
  STATE_PATH,
  TEMPLATE_DIR,
  TEMPLATE_PLUGINS_DIR,
  TEMPLATE_OBSIDIAN_DIR,
  pathExists,
} from '../lib/cli.ts';

async function scanPlugins() {
  const plugins = [];
  for (const id of (await readdir(TEMPLATE_PLUGINS_DIR)).sort()) {
    try {
      const manifest = JSON.parse(await readFile(join(TEMPLATE_PLUGINS_DIR, id, 'manifest.json'), 'utf8'));
      plugins.push({ id, name: manifest.name, version: manifest.version });
    } catch {
      // Not a plugin directory
    }
  }
  return plugins;
}

async function entriesOf(dir: string) {
  return (await readdir(dir, { withFileTypes: true })).filter((e) => !e.name.startsWith('.'));
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    check: args.includes('--check'),
    json: args.includes('--json'),
  };
}

async function main() {
  const args = parseArgs();
  const problems: string[] = [];

  const plugins = await scanPlugins();
  const pluginsChanged = JSON.stringify(plugins) !== JSON.stringify(STATE.plugins);

  const dirs = STATE.dirs;
  const classifiedDirs = new Set([
    ...dirs.selectable,
    ...dirs.pluginLinked.map((c) => c.dir),
    ...dirs.excluded,
  ]);
  for (const entry of await entriesOf(TEMPLATE_DIR)) {
    if (entry.isDirectory() && !classifiedDirs.has(entry.name)) {
      problems.push(`Directory "${entry.name}" is in template/ but not listed in state.json (dirs.selectable, pluginLinked or excluded)`);
    }
  }
  for (const dir of classifiedDirs) {
    if (!(await pathExists(join(TEMPLATE_DIR, dir)))) {
      problems.push(`Directory "${dir}" is listed in state.json but missing from template/`);
    }
  }
  const pluginIds = new Set(plugins.map((p) => p.id));
  for (const { plugin } of dirs.pluginLinked) {
    if (!pluginIds.has(plugin)) problems.push(`dirs.pluginLinked refers to plugin "${plugin}", which is not in template/.obsidian/plugins`);
  }

  const syncableSettings = STATE.settings.syncable.map((s) => s.name);
  const classifiedSettings = new Set([...syncableSettings, ...STATE.settings.excluded, 'plugins']);
  for (const entry of await entriesOf(TEMPLATE_OBSIDIAN_DIR)) {
    if (!classifiedSettings.has(entry.name)) {
      problems.push(`".obsidian/${entry.name}" is in template/ but not listed in state.json (settings.syncable or excluded)`);
    }
  }
  for (const setting of STATE.settings.syncable) {
    const target = join(TEMPLATE_OBSIDIAN_DIR, setting.name);
    if (!(await pathExists(target))) {
      problems.push(`Setting "${setting.name}" is listed in state.json but missing from template/.obsidian`);
      continue;
    }
    const actual = (await stat(target)).isDirectory() ? 'directory' : 'file';
    if (actual !== setting.type) problems.push(`Setting "${setting.name}" is a ${actual}, but state.json says ${setting.type}`);
  }

  const updated = pluginsChanged && !args.check;
  if (updated) {
    await writeFile(STATE_PATH, `${JSON.stringify({ ...STATE, plugins }, null, 2)}\n`);
  }

  if (args.json) {
    console.log(JSON.stringify({
      plugins,
      pluginsChanged,
      updated,
      problems,
      valid: problems.length === 0,
    }, null, 2));
  } else {
    if (pluginsChanged) {
      console.log(updated ? `Updated state.json plugins (${plugins.length}).` : `state.json plugins are out of date (${plugins.length}).`);
    } else {
      console.log(`state.json plugins are current (${plugins.length}).`);
    }
    for (const problem of problems) console.error(`- ${problem}`);
    if (problems.length > 0) {
      console.error(args.check ? 'state.json is out of date.' : 'Fix the items above in state.json, then re-run.');
    } else {
      console.log('state.json matches the template.');
    }
  }

  if (problems.length > 0) process.exit(1);
}

main().catch((err) => {
  console.error(String(err));
  process.exit(1);
});
