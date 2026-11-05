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
  const parentKey = await getParentPropertyKey(app);
  const notesBaseName = `Notes - ${project.basename}.base`;
  const baseFilePath = projectDir ? `${projectDir}/${notesBaseName}` : notesBaseName;

  // Match the project file by exact path: a project is not always a folder note,
  // so the folder base's folder-name check would miss its children.
  // Escape for the double-quoted Bases string, then for the YAML single-quoted scalar.
  const projectPath = project.path.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/'/g, "''");

  const content = `filters:
  and:
    - 'if(note["${parentKey}"], !list(note["${parentKey}"]).filter(value.asFile().path == "${projectPath}").isEmpty(), false)'
views:
  - type: table
    name: Table
    order:
      - file.name
      - file.tags
`;

  await createOrOpenFile(app, baseFilePath, content, {
    label: notesBaseName,
    folder: projectDir || "/",
  });
};
