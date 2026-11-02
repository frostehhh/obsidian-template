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
  const { findProjectsInDirectory, createTaskForProject } = await vaultRequire(app, "lib/TaskNotes/helpers");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  let currentDirPath = file.parent.path === "/" ? "" : file.parent.path;
  let levelsSearched = 0;
  let project = null;
  const candidateFolderNotes = [];

  // Phase 1: Search all directory levels for project notes,
  // collecting folder-note candidates along the way.
  while (levelsSearched <= MAX_PARENT_DIRECTORY_LEVELS_TO_SEARCH) {
    const dirName = currentDirPath === "" ? app.vault.getName() : currentDirPath.split("/").pop();
    const projects = findProjectsInDirectory(app, currentDirPath);

    if (projects.length === 1) {
      project = projects[0];
      break;
    }

    if (projects.length > 1) {
      const projectNames = projects.map((p) => `"${p.basename}"`).join(", ");
      new Notice(`Multiple projects found in "${dirName}": ${projectNames}. Expected exactly one.`);
      return;
    }

    // No project in this directory — collect matching folder note for later
    const folderNotePath = currentDirPath ? `${currentDirPath}/${dirName}.md` : `${dirName}.md`;
    const folderNote = app.vault.getAbstractFileByPath(folderNotePath);
    if (folderNote) {
      candidateFolderNotes.push({
        file: folderNote,
        label: `${dirName}.md  (${currentDirPath || "/"})`,
      });
    }

    // Move up one parent level
    if (currentDirPath === "") break;
    const parts = currentDirPath.split("/");
    parts.pop();
    currentDirPath = parts.join("/");
    levelsSearched++;
  }

  // Phase 2: No project found — offer to convert a collected folder note
  if (!project && candidateFolderNotes.length > 0) {
    const labels = candidateFolderNotes.map((c) => c.label);
    const chosen = await quickAddApi.suggester(
      labels,
      candidateFolderNotes.map((c) => c.file)
    );
    if (chosen) {
      await app.fileManager.processFrontMatter(chosen, (fm) => {
        const existing = fm.tags || [];
        const tags = Array.isArray(existing) ? [...existing] : [existing];
        if (!tags.includes("task")) tags.push("task");
        if (!tags.includes("project")) tags.push("project");
        fm.tags = tags;
      });
      new Notice(`Converted "${chosen.basename}" to a project.`);
      project = chosen;
    }
  }

  if (!project) {
    new Notice(`No project found in "${file.parent.name}" or up to ${MAX_PARENT_DIRECTORY_LEVELS_TO_SEARCH} parent directories.`);
    return;
  }

  const taskTitle = await quickAddApi.inputPrompt("Task title");
  if (!taskTitle) return;

  const movedFile = await createTaskForProject(app, project, { title: taskTitle });
  if (movedFile) {
    await openFile(app, movedFile);
  }
};
