const SCRIPTS_PATH = "--Configurations--/Scripts/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${SCRIPTS_PATH}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

function splitTemplate(raw) {
  const match = raw.match(/^---\n([\s\S]*?)\n---[ \t]*\r?\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: "", body: raw.trim() };
  }
  return { frontmatter: match[1], body: match[2] };
}

async function readTemplateContent(app, templates) {
  const paths = Array.isArray(templates) ? templates : [templates];
  const frontmatters = [];
  const bodies = [];
  for (const path of paths) {
    if (!app.vault.getAbstractFileByPath(path)) {
      throw new Error(`Template not found: "${path}".`);
    }
    const raw = await app.vault.adapter.read(path);
    const { frontmatter, body } = splitTemplate(raw);
    if (frontmatter) frontmatters.push(frontmatter);
    if (body.trim()) bodies.push(body.trim());
  }

  const parts = [];
  if (frontmatters.length) parts.push(`---\n${frontmatters.join("\n")}\n---\n`);
  if (bodies.length) parts.push(bodies.join("\n\n"));
  return parts.join("\n");
}

async function createNoteFromPresets(app, quickAddApi, presets, options = {}) {
  const { ensureFolder, createAndOpenFile } = await vaultRequire(app, "lib/utils");

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
  await createAndOpenFile(app, notePath, content, { label: fileName, folder: chosen.path });
}

module.exports = { createNoteFromPresets };
