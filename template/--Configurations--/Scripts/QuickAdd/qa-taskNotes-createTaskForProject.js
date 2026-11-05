const SCRIPTS_PATH = "--Configurations--/Scripts/QuickAdd";

async function vaultRequire(app, name) {
  const relPath = name.endsWith(".js") ? name : `${name}.js`;
  const src = await app.vault.adapter.read(`${SCRIPTS_PATH}/${relPath}`);
  const mod = { exports: {} };
  new Function("module", "exports", src)(mod, mod.exports);
  return mod.exports;
}

const MAX_PARENT_DIRECTORY_LEVELS_TO_SEARCH = 2;

module.exports = async (params) => {
  const { app, quickAddApi } = params;
  const { getActiveFile, openFile } = await vaultRequire(app, "lib/utils");
  const { resolveProject, createTaskForProject } = await vaultRequire(app, "lib/TaskNotes/helpers");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const project = await resolveProject(app, quickAddApi, file, MAX_PARENT_DIRECTORY_LEVELS_TO_SEARCH);
  if (!project) return;

  const taskTitle = await quickAddApi.inputPrompt(`Task title for "${project.basename}"`);
  if (!taskTitle) return;

  const movedFile = await createTaskForProject(app, project, { title: taskTitle });
  if (movedFile) {
    await openFile(app, movedFile);
  }
};
