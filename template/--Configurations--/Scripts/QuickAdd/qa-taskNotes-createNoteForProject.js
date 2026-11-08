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
  const { getActiveFile, openFile, ensureFolder } = await vaultRequire(app, "lib/utils");
  const { getParentPropertyKey } = await vaultRequire(app, "lib/excalibrain");
  const { resolveProject } = await vaultRequire(app, "lib/TaskNotes/helpers");

  const file = getActiveFile(app);
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const project = await resolveProject(app, quickAddApi, file, MAX_PARENT_DIRECTORY_LEVELS_TO_SEARCH);
  if (!project) return;

  const projectDir = project.parent.path === "/" ? "" : project.parent.path;
  const notesFolder = projectDir ? `${projectDir}/Notes` : "Notes";

  const title = await quickAddApi.inputPrompt(`Note title for "${project.basename}"`);
  if (!title) return;

  await ensureFolder(app, notesFolder);

  const notePath = `${notesFolder}/${title}.md`;
  if (app.vault.getAbstractFileByPath(notePath)) {
    new Notice(`"${title}.md" already exists.`);
    return;
  }

  const newFile = await app.vault.create(notePath, "");

  // The project base matches notes whose parent property links to the project
  // file, so this link is what makes the note appear there.
  const parentLinkText = app.metadataCache.fileToLinktext(project, notePath);
  const parentKey = await getParentPropertyKey(app);
  await app.fileManager.processFrontMatter(newFile, (fm) => {
    fm[parentKey] = `[[${parentLinkText}]]`;
  });

  new Notice(`Created "${title}" for project "${project.basename}"`);
  await openFile(app, newFile);
};
