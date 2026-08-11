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
  const { getTaskNotesApi, ensureFolderTaskNote } = await vaultRequire(app, "lib/TaskNotes/helpers");
  const tasksDefault = await vaultRequire(app, "lib/TaskNotes/templates/tasks-default");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const { folderPath, folderName } = getFolderContext(file);
  const notePath = folderPath ? `${folderPath}/${folderName}` : folderName;
  const tasksBaseName = `Tasks - ${folderName}.base`;
  const tasksBasePath = folderPath ? `${folderPath}/${tasksBaseName}` : tasksBaseName;

  const api = getTaskNotesApi(app);
  if (!api) return;
  await ensureFolderTaskNote(app, api, folderPath, folderName);

  const content = tasksDefault([`projects.contains(link("${notePath}"))`]);

  await createOrOpenFile(app, tasksBasePath, content, {
    label: tasksBaseName,
    folder: folderPath || "/",
  });
};
