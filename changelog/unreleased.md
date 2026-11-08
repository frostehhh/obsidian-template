# Unreleased

<!-- One line per user-visible change, added in the same commit as the change.
Group under Added / Changed / Deprecated / Removed / Fixed / Security.
Breaking changes need a **Migration** note. -->

## Changed

- The `obsidian-markdown` skill now uses `dateCreated` instead of `date` in its property examples and reference, so agents write the same date property the template vaults use. Re-sync the skills (`mise run sync`) to pick it up
