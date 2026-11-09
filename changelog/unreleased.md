# Unreleased

<!-- One line per user-visible change, added in the same commit as the change.
Group under Added / Changed / Deprecated / Removed / Fixed / Security.
Breaking changes need a **Migration** note. -->

## Added

- `TaskNotes - Create note for project` QuickAdd choice (`qa-taskNotes-createNoteForProject.js`): creates a note in the project's `Notes/` folder with `Parent` linked to the project, so it shows up in the base from `Create or Open project base`. Run `mise run sync` for the script and add the choice to the vault's QuickAdd `data.json`
- `TaskNotes - Create or Open Tasks Default View for Project` QuickAdd choice (`qa-taskNotes-createOrOpenTasksDefaultViewForProject.js`): finds the project in the current or parent directories and creates or opens `Tasks - <project>.base` in the project's folder, listing tasks whose `projects` include the project. Run `mise run sync` for the script and add the choice to the vault's QuickAdd `data.json`
- Vault updates with the `obsidian-template-vault-update` skill and `mise run vault-update:report|apply|record`. The report lists every template change since the vault's last update, grouped by commit with its changelog line, so a new QuickAdd script and its `data.json` choice arrive together. It compares each file and each JSON key (QuickAdd choices matched by id) with the vault, and detects moves. You choose per change: apply, defer, decline (stored as `decline` in the vault's `sync.config.json`) or keep the vault's version. See `docs/specs/vault-update.md`
  - **Migration:** a vault's first update converts its `template.lock.json` from v1 to v2 and keeps the old lock as `.obsidian/template.lock.v1.json`. Run it with the skill. Once a vault has a v2 lock, `mise run sync` refuses it
<!-- migrations: none -->

## Changed

- `mise run sync` and `agent:sync` are DRAFT. They are known to leave vaults half updated: a new QuickAdd script arrives without its `data.json` choice. They now print a warning; use the vault-update skill instead

- The `obsidian-markdown` skill now uses `dateCreated` instead of `date` in its property examples and reference, so agents write the same date property the template vaults use. Re-sync the skills (`mise run sync`) to pick it up

## Fixed

- Non-interactive `sync` no longer overrides a vault's `syncDataJson: true` when `--data-json` is not given
- Saving the wizard's selections to a vault's `sync.config.json` keeps its other keys (`protect`, `exclude`, `pin`, `patches`, `decline`) instead of overwriting the file
