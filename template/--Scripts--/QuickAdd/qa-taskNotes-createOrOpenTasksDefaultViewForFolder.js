const SCRIPTS_PATH = "--Scripts--/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${SCRIPTS_PATH}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

module.exports = async (params) => {
  const { app } = params;
  const { getActiveFile, getFolderContext, createOrOpenFile } = await vaultRequire(app, "lib/utils");
  const { getTaskNotesApi } = await vaultRequire(app, "lib/TaskNotes/helpers");
  const tasksDefault = await vaultRequire(app, "lib/TaskNotes/templates/tasks-default");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const { folderPath, folderName } = getFolderContext(file);
  const notePath = folderPath ? `${folderPath}/${folderName}` : folderName;
  const tasksBasePath = folderPath ? `${folderPath}/Tasks.base` : "Tasks.base";

  if (!app.vault.getAbstractFileByPath(`${notePath}.md`)) {
    const api = getTaskNotesApi(app);
    if (!api) return;
    const task = await api.tasks.create({ title: folderName });
    if (task.path !== `${notePath}.md`) {
      await app.vault.rename(app.vault.getAbstractFileByPath(task.path), `${notePath}.md`);
    }
    new Notice(`Created task note "${notePath}".`);
  }

  const content = tasksDefault([`projects.contains(link("${notePath}"))`]);

  await createOrOpenFile(app, tasksBasePath, content, {
    label: "Tasks.base",
    folder: folderPath || "/",
  });
};
