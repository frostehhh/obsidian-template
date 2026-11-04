# Unreleased

<!-- One line per user-visible change, added in the same commit as the change.
Group under Added / Changed / Deprecated / Removed / Fixed / Security.
Breaking changes need a **Migration** note. -->

## Changed

- QuickAdd macros "TaskNotes - Create task for project" and "TaskNotes - Set current note as project" are no longer registered as command palette commands (`command: false`). Run them from the QuickAdd menu, or turn the lightning-bolt toggle back on in QuickAdd settings. Syncing `data.json` (`--data-json`) is needed to apply this to existing vaults
