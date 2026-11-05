# Unreleased

<!-- One line per user-visible change, added in the same commit as the change.
Group under Added / Changed / Deprecated / Removed / Fixed / Security.
Breaking changes need a **Migration** note. -->

## Fixed

- The folder base ("Folder - Create or Open folder base") no longer shows another folder's notes when a different note has focus, for example in a split pane or the sidebar. It now stores the folder note's path in a reserved `qaFolderChild` formula instead of using `this`. Running the command again on an existing base updates only that formula (for example after the folder moved) and migrates bases that still use the old filter. Other filters, formulas and views in the base are left untouched. Re-sync `--Configurations--/Scripts/QuickAdd` (`mise run sync`) to get the new script, then run the command once in each existing folder base
