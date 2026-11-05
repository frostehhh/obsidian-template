# Unreleased

<!-- One line per user-visible change, added in the same commit as the change.
Group under Added / Changed / Deprecated / Removed / Fixed / Security.
Breaking changes need a **Migration** note. -->

## Added

- Version tracking: `sync` writes `.obsidian/template.lock.json` into each vault, recording the template version and file hashes of every synced item. `compare` shows `last synced: <version>` per vault (or `untracked`). See `docs/specs/sync-versioning.md`
- `sync` and `compare` read the template from a git tag instead of the working tree: `--from <ref>` (default: latest `v*` tag, `--from working-tree` for unreleased changes). Uncommitted edits in `template/` no longer reach vaults
- Three-way sync (template, last synced state, vault): local edits in a vault are kept, files removed from the template are deleted from the vault if the vault copy is unchanged, and files changed on both sides are reported as conflicts. `--on-conflict skip|take-template|keep-vault` sets the policy (default `skip`; non-interactive runs exit 1 while conflicts remain)
- `--assume <version>` gives `sync` a base for vaults that have no lock yet, e.g. `mise run sync -- --assume v0.2.0` for a vault known to be at 0.2.0
- `compare` reports local overrides (`N local`) and files the template removed (`stale`); local overrides count as in sync
- `mise run test` runs the unit tests

## Changed

- `sync --dry-run` JSON now lists per item the files to `add`, `update`, `delete`, `keep` and `conflict` instead of `filesToCopy`/`filesToSkip`/`subDirs`
- `sync` and `compare` JSON file lists gain `overridden` and `stale`; `sync --json` gains `conflicts`
- A vault without a lock treats existing files that differ from the template as conflicts instead of overwriting them. **Migration:** for existing vaults run `mise run sync -- --assume <version the vault is at>`, or `--on-conflict take-template` to overwrite as before
