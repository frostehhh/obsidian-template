# Unreleased

<!-- One line per user-visible change, added in the same commit as the change.
Group under Added / Changed / Deprecated / Removed / Fixed / Security.
Breaking changes need a **Migration** note. -->

## Added

- Add QuickAdd macro "TaskNotes - Create or Open project base" that finds the project note (tags `task` + `project`) in the current or parent directories and creates or opens `Notes - <project>.base` in the project's folder, listing notes whose `Parent` is the project. If no project is found, it offers to convert a folder note. Syncing QuickAdd `data.json` (`--data-json`) is needed to add it to existing vaults
