# Sync versioning

Status: phase 1 implemented (tag source, lock file, three-way reconcile). Phases 2 and 3 are planned.

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

## Plan

Phase 1 builds a plan (a list of per-file decisions per item) before writing anything. `--dry-run` prints it. The plan JSON has the shape `{ kind, id, add[], update[], delete[], keep[], conflict[] }` per item.

## Roadmap

1. **Phase 1 (done):** tag source, lock, three-way reconcile with deletions, conflict policy, `--assume`, lock-aware compare.
2. **Phase 2:** vault config `protect` (globs sync never touches), `exclude`, `pin` (version range a vault stays within); `--plan <file>` / `--apply <file>`; staged writes.
3. **Phase 3:** `migrations/<version>.ts` executed in semver order for versions in (lock version, target], recorded in the lock; key-level `data.json` merge using the base from git; vault `patches` (JSON merge patches reapplied after every sync); release check that every changelog entry marked as migration has one.

## Known limitations of phase 1

- `state.json` is read from the working tree, not from the source ref. An item removed from the template between versions is only cleaned up if it is still listed there.
- Writes are per file, not staged across the whole run. The lock is written last, so a failed run is safe to repeat.
