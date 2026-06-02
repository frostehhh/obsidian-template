const path = require("path");
const resolve = require(path.join(app.vault.adapter.basePath, "--Scripts--", "QuickAdd", "lib", "resolver"))(app);
const tasksDefault = resolve("lib/TaskNotes/templates/tasks-default");

module.exports = async (params) => {
  const { app } = params;

  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const folderPath = file.parent.path === "/" ? "" : file.parent.path;
  const folderName = file.parent.name;
  const basePath = folderPath ? `${folderPath}/_${folderName}.base` : `_${folderName}.base`;

  if (app.vault.getAbstractFileByPath(basePath)) {
    new Notice(`"_${folderName}.base" already exists.`);
    return;
  }

  const tasksFolder = folderPath ? `${folderPath}/Tasks` : "Tasks";
  const content = tasksDefault([`file.inFolder("${tasksFolder}")`]);

  const newFile = await app.vault.create(basePath, content);
  new Notice(`Created "_${folderName}.base" in "${folderPath || "/"}"`);
  const leaf = app.workspace.getLeaf(false);
  await leaf.openFile(newFile);
};
