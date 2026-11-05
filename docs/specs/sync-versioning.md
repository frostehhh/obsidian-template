# Sync versioning

Status: phases 1 and 2 implemented (tag source, lock file, three-way reconcile, vault policy, saved plans). Phase 3 is planned.

## Goals

- **Version tracking.** Every vault records which template version each synced item was last reconciled with.
- **Deterministic sync.** The result depends only on three inputs: the template at a tagged version, the vault's recorded state, and the vault's configuration. Uncommitted work in `template/` cannot leak into a vault.
- **Vault-level configuration on top of the template.** Vault owners can keep local changes and declare intentional deviations without them being treated as drift.

## Concepts

| Term | Meaning |
|---|---|
| source | The template content being synced: a git tag (default: latest `v*` tag) or, explicitly, the working tree |
| item | A unit of sync: `plugin:<id>`, `dir:<name>` or `setting:<name>` |
| lock | `.obsidian/template.lock.json` in a vault. Written only by sync. Records the content hash of every tracked file as of the last reconcile (the *base*), and the template version each item was synced from |
| config | `.obsidian/sync.config.json`. Hand-edited. Says what the vault owner wants synced |

### Hashes

Every file is identified by its git blob hash (`sha1("blob <size>\0" + content)`). For a git source this is the object id, so comparing needs no file reads. The same function hashes working-tree and vault files, so all three sides are comparable.

### Lock file

```json
{
  "lockVersion": 1,
  "items": {
    "plugin:quickadd": {
      "templateVersion": "0.3.1",
      "files": { "main.js": "<hash>", "manifest.json": "<hash>" }
    }
  }
}
```

- Keys and file paths are sorted and there are no timestamps, so identical inputs give identical bytes.
- The version is per item, because a vault may sync some items more often than others.
- Plugin `data.json` and `genericPreviewCache.json` are never recorded (see "Data files").
- Written last, atomically (temp file + rename). A failed run leaves the previous lock in place.

## Source

`--from <ref>` selects the source.

- Default: the latest `v*` tag, read straight from git objects. If no tag exists, sync falls back to the working tree and prints a warning.
- `--from vX.Y.Z` (any git ref) syncs that version, which also allows deliberate rollbacks.
- `--from working-tree` reads `template/` from disk. This is for testing template changes before release. The lock records the version as `working-tree`.

## Reconcile (three-way, per file)

For each file, three hashes are compared. `t` is the source, `b` is the lock (base), `v` is the vault. `-` means absent.

| Condition | Action |
|---|---|
| `t == v` | **noop**. The base becomes `t` |
| `v == b`, `t == -` | **delete** (only possible for files recorded in the lock) |
| `v == b`, `b == -` | **add** |
| `v == b`, otherwise | **update** |
| `v != b`, `t == b` | **keep**: a local override. Reported, never overwritten or restored |
| `v != b`, `t != b` | **conflict** |
| any of add, update, delete, conflict on a protected path | **protected**: nothing is written, the base stays |

Consequences:

- Files that exist only in the vault have `b == -`, `t == -` and `v != -`. They are kept, so sync never deletes a file it did not put there.
- A vault file the user deleted stays deleted while the template file is unchanged.
- A vault without a lock has `b == -` everywhere. Existing files that differ from the template are conflicts, so nothing is silently overwritten.

### Conflicts

`--on-conflict <policy>`:

- `skip` (default): leave the file alone and keep the base, so the conflict is reported again next run. Non-interactive runs exit non-zero if any conflicts remain.
- `take-template`: apply the template change. The base becomes `t`.
- `keep-vault`: leave the file alone and set the base to `t`, which turns it into a local override.

### Adopting a vault that has no lock

`--assume <version>` supplies the base for items that have no lock entry. The base hashes are read from that tag. A vault known to be at 0.2.0 therefore updates cleanly to 0.3.1, with local edits kept and removed files deleted.

### Data files

Plugin `data.json` and `genericPreviewCache.json` hold per-vault state. They are outside the three-way logic:

- Copied only when missing from the vault.
- With `--data-json` (or `syncDataJson`) they are overwritten from the source.
- Never recorded in the lock.

Phase 3 replaces this with a key-level merge.

## Compare

`compare` uses the same source and lock, so it reports what sync would do. Per item:

- Local overrides count as in sync and are shown as `N local`.
- Files that the template removed and the vault still has unchanged show as `stale` and make the item `outdated`.
- The header shows the template version in use and the version(s) the vault was last synced from, or `untracked` when there is no lock.

## Vault configuration on top of the template

`.obsidian/sync.config.json` (vault) and `sync.config.json` (repo) accept three more keys. Precedence for pin is vault over repo; protect and exclude add up across both.

```json
{
  "pin": "0.2.x",
  "protect": ["Notes/Templates/**", "--Configurations--/Scripts/QuickAdd/my-*.js"],
  "exclude": ["plugin:excalidraw", "setting:templates.json"]
}
```

- **`protect`**: globs on vault-relative paths (`*` within a directory, `**` across directories, `?`, a trailing `/` means everything below). Sync never writes or deletes a protected path, whatever the template does. The lock base stays as it was, so removing the protection later updates the file cleanly. Differences in protected files are reported as local overrides (`N local`) and count as in sync. Protect wins over everything, including `--data-json` and `--on-conflict take-template`.
- **`exclude`**: items left out entirely, written `kind:name` (`plugin:<id>`, `dir:<name>`, `setting:<name>`, case-insensitive). They are dropped from sync and from compare, even when selected by `defaultPlugins` or the wizard.
- **`pin`**: a version range (`0.3.1`, `0.2.x`, `^0.3.0`, `~0.3.0`). Without `--from`, the source is the highest `v*` tag inside the range, for both sync and compare, so a pinned vault is `in sync` against its own version. An explicit `--from` outside the pin is refused unless `--ignore-pin` is given. `--from working-tree` is not checked against the pin.

Sync resolves the source per vault, so vaults with different pins can be synced in one run.

## Plan and apply

Sync builds a plan (per-file decisions per item) before writing anything.

- `--dry-run` prints it as JSON: per item `{ kind, id, baseKnown, add[], update[], delete[], keep[], protected[], conflict[] }`.
- `--plan <file>` saves it instead of applying. The file pins the template commit, every decision with the hash of the template, base and vault file, and a digest of the vault's lock file. Plans from `--from working-tree` are refused, as they cannot be reproduced.
- `--apply <file>` runs the saved plan as written, with no selection flags. Before touching any vault it checks that the vault exists, that its lock is unchanged, and that every file the plan covers still has the hash it had when the plan was made. If anything differs, nothing is changed and the command exits 1 with a list. `--on-conflict` is chosen at apply time.

Writes are staged: every new file is first written next to its destination as `<name>.sync-tmp`. Only when all of them succeed are they renamed into place, deletions run, `community-plugins.json` is updated and the lock is written, last. A failure while staging removes the temp files and changes nothing.

## Roadmap

1. **Phase 1 (done):** tag source, lock, three-way reconcile with deletions, conflict policy, `--assume`, lock-aware compare.
2. **Phase 2 (done):** vault config `protect`, `exclude` and `pin`; `--plan <file>` / `--apply <file>`; staged writes.
3. **Phase 3:** `migrations/<version>.ts` executed in semver order for versions in (lock version, target], recorded in the lock; key-level `data.json` merge using the base from git; vault `patches` (JSON merge patches reapplied after every sync); release check that every changelog entry marked as migration has one.

## Known limitations

- `state.json` is read from the working tree, not from the source ref. An item removed from the template between versions is only cleaned up if it is still listed there.
- Renames during the final rename step are not transactional. If the process dies in the middle of it, rerunning sync completes the job (the lock is still the old one).
- `protect` and `exclude` have no CLI flags; they come from the config files only.
