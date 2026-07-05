const SCRIPTS_PATH = "--Scripts--/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${SCRIPTS_PATH}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

function extractFrontmatterBody(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---\s*\n?/);
  return match ? match[1] : raw.trim();
}

async function readTemplateContent(app, templates) {
  const paths = Array.isArray(templates) ? templates : [templates];
  const bodies = [];
  for (const path of paths) {
    if (!app.vault.getAbstractFileByPath(path)) {
      throw new Error(`Template not found: "${path}".`);
    }
    const raw = await app.vault.adapter.read(path);
    bodies.push(extractFrontmatterBody(raw));
  }
  return `---\n${bodies.join("\n")}\n---\n`;
}

async function createNoteFromPresets(app, quickAddApi, presets, options = {}) {
  const { ensureFolder, openFile } = await vaultRequire(app, "lib/utils");

  let chosen;
  if (presets.length === 1) {
    chosen = presets[0];
  } else {
    const display = presets.map((p) => `${p.noteName} | ${p.path}`);
    chosen = await quickAddApi.suggester(display, presets);
    if (!chosen) return;
  }

  let content;
  try {
    content = await readTemplateContent(app, chosen.templates);
  } catch (e) {
    new Notice(e.message);
    return;
  }

  const title = await quickAddApi.inputPrompt(`${chosen.noteName} title (leave blank for date only)`);

  const datePrefix = window.moment().format("YYYY-MM-DD");
  const fileName = title?.trim()
    ? options.datePrefixFilename
      ? `${datePrefix} - ${title.trim()}`
      : title.trim()
    : datePrefix;

  content = content.replace(
    /<%\s*tp\.date\.now\(\s*(?:format\s*=\s*)?["']([^"']*)["']\s*\)\s*%>/g,
    (_, fmt) => window.moment().format(fmt)
  );

  await ensureFolder(app, chosen.path);

  const notePath = `${chosen.path}/${fileName}.md`;
  if (app.vault.getAbstractFileByPath(notePath)) {
    new Notice(`"${fileName}.md" already exists.`);
    return;
  }

  const newFile = await app.vault.create(notePath, content);
  new Notice(`Created "${fileName}" in "${chosen.path}"`);
  await openFile(app, newFile);
}

module.exports = { createNoteFromPresets };
