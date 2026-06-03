module.exports = async (params) => {
  const { app, quickAddApi } = params;

  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice("No active file.");
    return;
  }

  const folderPath = file.parent.path === "/" ? "" : file.parent.path;
  const folderName = file.parent.name;
  const tasksFolder = folderPath ? `${folderPath}/Tasks` : "Tasks";

  const taskTitle = await quickAddApi.inputPrompt("Task title");
  if (!taskTitle) return;

  const api = app.plugins.plugins.tasknotes?.api;
  if (!api) {
    new Notice("TaskNotes plugin is not available.");
    return;
  }

  const projectFilePath = folderPath ? `${folderPath}/${folderName}.md` : `${folderName}.md`;
  const projectFile = app.vault.getAbstractFileByPath(projectFilePath);
  const projects = projectFile ? [`[[${folderName}]]`] : [];

  if (!app.vault.getAbstractFileByPath(tasksFolder)) {
    await app.vault.createFolder(tasksFolder);
  }

  const task = await api.tasks.create({ title: taskTitle, projects });
  await api.tasks.move(task.path, tasksFolder);

  const movedPath = `${tasksFolder}/${task.path.split("/").pop()}`;
  const movedFile = app.vault.getAbstractFileByPath(movedPath);
  if (movedFile) {
    if (projects.length) {
      await app.fileManager.processFrontMatter(movedFile, (fm) => {
        fm.projects = projects;
      });
    }
    const leaf = app.workspace.getLeaf(false);
    await leaf.openFile(movedFile);
  }

  new Notice(`Created task "${taskTitle}" in "${tasksFolder}"`);
};
