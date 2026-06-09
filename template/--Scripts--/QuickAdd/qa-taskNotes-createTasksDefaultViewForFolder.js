const basePath = "--Scripts--/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${basePath}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

module.exports = async (params) => {
  const { app } = params;

  const tasksDefault = await vaultRequire(app, "lib/TaskNotes/templates/tasks-default");

  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const folderPath = file.parent.path === "/" ? "" : file.parent.path;
  const folderName = file.parent.name;
  const notePath = folderPath ? `${folderPath}/${folderName}` : folderName;
  const basePath = folderPath ? `${folderPath}/Tasks.base` : `Tasks.base`;

  if (!app.vault.getAbstractFileByPath(`${notePath}.md`)) {
    const api = app.plugins.plugins.tasknotes?.api;
    if (!api) {
      new Notice("TaskNotes plugin is not available.");
      return;
    }
    const task = await api.tasks.create({ title: folderName });
    if (task.path !== `${notePath}.md`) {
      await app.vault.rename(app.vault.getAbstractFileByPath(task.path), `${notePath}.md`);
    }
    new Notice(`Created task note "${notePath}".`);
  }

  if (app.vault.getAbstractFileByPath(basePath)) {
    new Notice(`"Tasks.base" already exists.`);
    return;
  }

  const content = tasksDefault([`projects.contains(link("${notePath}"))`]);

  const newFile = await app.vault.create(basePath, content);
  new Notice(`Created "Tasks.base" in "${folderPath || "/"}"`);
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(newFile);
};
