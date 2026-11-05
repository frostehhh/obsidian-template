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
- Vault-level policy in `.obsidian/sync.config.json` (or the repo-level `sync.config.json`): `protect` (globs sync never writes or deletes), `exclude` (items like `plugin:excalidraw` that sync and compare skip) and `pin` (a version range such as `0.2.x` that keeps a vault on the highest matching tag). `--ignore-pin` overrides a pin for one run
- `sync --plan <file>` saves what sync would do, pinned to the template commit and the current state of every file; `sync --apply <file>` runs it and refuses, changing nothing, if the vault or its lock changed since. `--dry-run` JSON gains `protected`
- Migrations: `migrations/<version>.ts` in the template repo carry vaults across changes that file sync cannot express (renaming a key in a plugin's `data.json`, moving a file). Sync runs the ones a vault has not run yet, oldest first, records them in `template.lock.json` and prints what they did. `--dry-run` and `--plan` list them. See `migrations/README.md`
- `--data-json` now merges a plugin's `data.json` key by key instead of overwriting it: template changes since the last merge arrive, your own settings stay, QuickAdd-style arrays of objects with an `id` merge by id, and keys changed on both sides are conflicts (`data.json [key]`) resolved with `--on-conflict`
- `patches` in a vault's `sync.config.json` (JSON merge patches by vault-relative path) are reapplied after every sync, so deliberate deviations in plugin settings survive and are never conflicts
- `mise run release` refuses a changelog with a `**Migration**` entry unless `migrations/<version>.ts` exists or the changelog contains `<!-- migrations: none -->` (the steps are manual)
- `mise run test` runs the unit tests

## Changed

- Sync stages every new file next to its destination and renames them into place only after all writes succeeded; the lock is written last, so a failed run changes nothing in the vault
- `sync --dry-run` JSON now lists per item the files to `add`, `update`, `delete`, `keep` and `conflict` instead of `filesToCopy`/`filesToSkip`/`subDirs`
- `sync` and `compare` JSON file lists gain `overridden` and `stale`; `sync --json` gains `conflicts`
- A vault without a lock treats existing files that differ from the template as conflicts instead of overwriting them. **Migration:** for existing vaults run `mise run sync -- --assume <version the vault is at>`, or `--on-conflict take-template` to overwrite as before
- `--data-json` no longer overwrites `data.json` and never overwrites `genericPreviewCache.json`. **Migration:** the first merge into a vault synced before has no recorded base, so every key that differs is reported as a conflict; resolve once with `--on-conflict keep-vault` or `take-template` (or `--assume <version>`)
- `sync --dry-run` JSON gains `migrations` and `patches` per vault, and `sync --json` gains `notes`

<!-- migrations: none -->
(The migration steps above are manual: re-run sync with `--assume`/`--on-conflict`.)
