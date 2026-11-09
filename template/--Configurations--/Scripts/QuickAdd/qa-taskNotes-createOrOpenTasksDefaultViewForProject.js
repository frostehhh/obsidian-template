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
  const { getActiveFile, createOrOpenFile } = await vaultRequire(app, "lib/utils");
  const { getTaskNotesApi, resolveProject } = await vaultRequire(app, "lib/TaskNotes/helpers");
  const tasksDefault = await vaultRequire(app, "lib/TaskNotes/templates/tasks-default");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const api = getTaskNotesApi(app);
  if (!api) return;

  const project = await resolveProject(app, quickAddApi, file, MAX_PARENT_DIRECTORY_LEVELS_TO_SEARCH);
  if (!project) return;

  const projectDir = project.parent.path === "/" ? "" : project.parent.path;
  const tasksBaseName = `Tasks - ${project.basename}.base`;
  const tasksBasePath = projectDir ? `${projectDir}/${tasksBaseName}` : tasksBaseName;

  // A project is not always a folder note, so match it by exact path.
  const projectPath = project.path.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const content = tasksDefault([`projects.contains(link("${projectPath}"))`]);

  await createOrOpenFile(app, tasksBasePath, content, {
    label: tasksBaseName,
    folder: projectDir || "/",
  });
};
