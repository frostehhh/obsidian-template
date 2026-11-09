# Unreleased

<!-- One line per user-visible change, added in the same commit as the change.
Group under Added / Changed / Deprecated / Removed / Fixed / Security.
Breaking changes need a **Migration** note. -->

## Added

- `TaskNotes - Create note for project` QuickAdd choice (`qa-taskNotes-createNoteForProject.js`): creates a note in the project's `Notes/` folder with `Parent` linked to the project, so it shows up in the base from `Create or Open project base`. Run `mise run sync` for the script and add the choice to the vault's QuickAdd `data.json`
- `TaskNotes - Create or Open Tasks Default View for Project` QuickAdd choice (`qa-taskNotes-createOrOpenTasksDefaultViewForProject.js`): finds the project in the current or parent directories and creates or opens `Tasks - <project>.base` in the project's folder, listing tasks whose `projects` include the project. Run `mise run sync` for the script and add the choice to the vault's QuickAdd `data.json`

## Changed

- The `obsidian-markdown` skill now uses `dateCreated` instead of `date` in its property examples and reference, so agents write the same date property the template vaults use. Re-sync the skills (`mise run sync`) to pick it up
