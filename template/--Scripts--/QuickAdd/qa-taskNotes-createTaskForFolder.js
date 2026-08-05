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
  const { getActiveFile, openFile } = await vaultRequire(app, "lib/utils");
  const { createTaskInFolder } = await vaultRequire(app, "lib/TaskNotes/helpers");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const taskTitle = await quickAddApi.inputPrompt("Task title");
  if (!taskTitle) return;

  const movedFile = await createTaskInFolder(app, file, { title: taskTitle });
  if (movedFile) {
    await openFile(app, movedFile);
  }
};
