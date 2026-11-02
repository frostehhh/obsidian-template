const SCRIPTS_PATH = "--Configurations--/Scripts/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${SCRIPTS_PATH}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

module.exports = async (params) => {
  const { app } = params;
  const { getActiveFile } = await vaultRequire(app, "lib/utils");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  await app.fileManager.processFrontMatter(file, (fm) => {
    const existing = fm.tags || [];
    const tags = Array.isArray(existing) ? [...existing] : [existing];
    if (!tags.includes("task")) tags.push("task");
    if (!tags.includes("project")) tags.push("project");
    fm.tags = tags;
  });

  new Notice(`Set "${file.basename}" as a project (tags: task, project).`);
};
