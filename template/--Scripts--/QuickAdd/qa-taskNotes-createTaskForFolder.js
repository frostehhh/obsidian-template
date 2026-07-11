const SCRIPTS_PATH = "--Scripts--/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${SCRIPTS_PATH}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

module.exports = async (params) => {
  const { app, quickAddApi } = params;
  const { getActiveFile, getFolderContext, openFile, ensureFolder } = await vaultRequire(app, "lib/utils");
  const { getProjects, createTaskInFolder } = await vaultRequire(app, "lib/TaskNotes/helpers");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const { folderPath, folderName } = getFolderContext(file);
  const tasksFolder = folderPath ? `${folderPath}/Tasks` : "Tasks";

  const taskTitle = await quickAddApi.inputPrompt("Task title");
  if (!taskTitle) return;

  const api = app.plugins.plugins.tasknotes?.api;
  if (!api) {
    new Notice("TaskNotes plugin is not available.");
    return;
  }

  const projectFilePath = folderPath ? `${folderPath}/${folderName}.md` : `${folderName}.md`;
  const projects = getProjects(app, projectFilePath, tasksFolder);

  await ensureFolder(app, tasksFolder);

  const movedFile = await createTaskInFolder(app, api, { title: taskTitle, projects, folder: tasksFolder });
  if (movedFile) {
    await openFile(app, movedFile);
  }
};
