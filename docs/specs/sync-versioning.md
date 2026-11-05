# Sync versioning

Status: all three phases implemented (tag source, lock file, three-way reconcile, vault policy, saved plans, migrations, `data.json` merge, patches).

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
      "dataVersion": "0.3.1",
      "files": { "main.js": "<hash>", "manifest.json": "<hash>" }
    }
  },
  "migrations": ["0.3.2", "0.4.0"]
}
```

- Keys and file paths are sorted and there are no timestamps, so identical inputs give identical bytes.
- The version is per item, because a vault may sync some items more often than others.
- Plugin `data.json` and `genericPreviewCache.json` are never recorded in `files` (see "Data files"). `dataVersion` is the template version whose `data.json` was last merged into the vault's, and is the base of the next merge.
- `migrations` lists the migrations already run on the vault (see "Migrations"). Locks written before migrations existed lack it.
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

Plugin `data.json` and `genericPreviewCache.json` hold per-vault state, so they sit outside the per-file logic and are never recorded in `files`:

- Both are copied when missing from the vault.
- With `--data-json` (or `syncDataJson`), `data.json` is **merged key by key** instead of overwritten. `genericPreviewCache.json` is a cache and is never overwritten.

The merge is three-way on the parsed JSON: base is the template's `data.json` at the lock item's `dataVersion` (read from git), template is the source, vault is the vault's file.

- A side that did not change a key since the base never overrides the other side. So template changes arrive, the vault's own settings stay, and a key the template removed is removed only if the vault left it alone.
- Objects merge key by key. Arrays whose elements are all objects with a unique string `id` (QuickAdd choices) merge by id: vault order first, new template elements appended. Other arrays and scalars are atomic.
- A key changed on both sides, differently, is a conflict. It is listed as `data.json [path.to.key]` (for id-keyed arrays the id is a path segment). `--on-conflict` applies: `skip` keeps the vault value and reports, `keep-vault` keeps it silently, `take-template` takes the template value.
- Keys decided by a vault patch (see "Patches") are never conflicts.
- The file is written with the indentation and trailing newline it had.
- Without a base (no `dataVersion`, no `--assume`, or the tag is not in this checkout) the base is empty: keys only in the template are added, keys only in the vault stay, and keys that differ conflict.
- `dataVersion` moves to the synced version when the merge finishes without conflicts left to report, or when the conflict policy resolved them. With `skip` and conflicts it stays, so the conflicts come back next run.
- If either side is not valid JSON, `data.json` is a whole-file conflict.

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

### Patches

```json
{
  "patches": {
    ".obsidian/plugins/quickadd/data.json": { "persistInputPromptDrafts": true },
    ".obsidian/app.json": { "vimMode": true }
  }
}
```

`patches` maps vault-relative paths to RFC 7386 JSON merge patches (objects merge, `null` deletes a key, arrays replace). They are the declared deviations of a vault: reapplied after every sync, after the files and the migrations, and idempotent. A file that is missing is skipped. Protected paths are never patched. When a repo patch and a vault patch name the same path, the vault's replaces the repo's. A patch also settles any `data.json` merge conflict under the keys it names.

## Migrations

For changes plain file sync cannot express (renaming a key inside `data.json`, moving a file the user owns), the template repo carries `migrations/<x.y.z>.ts`. The format and rules are in `migrations/README.md`: a self-contained, idempotent module exporting `description` and `run(ctx)`, where `ctx` offers vault-confined JSON and file helpers that skip protected paths.

- **Source.** Migrations are read from the same git ref as the template, and loaded from a temp directory. Syncing a tag runs that tag's migrations.
- **Which run.** The lock's `migrations` list is authoritative: everything at or below the target version that is not listed is pending, oldest first. A lock without that list takes the oldest item version as the baseline. A vault with no lock runs none and records all up to the target as done, unless `--assume <version>` supplies a baseline. Syncing an older tag runs nothing and never forgets recorded migrations. `--from working-tree` has no upper bound, for testing.
- **When.** After files are in place and before the lock is written, followed by the patches. A failure leaves the old lock, and since migrations are idempotent a rerun is safe.
- **Visibility.** `--dry-run` and `--plan` list them (`migrations`), `--apply` runs the listed ones from the pinned commit and fails the plan if one is missing there. Log lines come back as `notes`.
- **Release check.** A changelog entry with a `**Migration**` note requires `migrations/<version>.ts` for that release, or `<!-- migrations: none -->` in the changelog to say the steps are manual. `mise run release` refuses otherwise.

## Plan and apply

Sync builds a plan (per-file decisions per item) before writing anything.

- `--dry-run` prints it as JSON: per item `{ kind, id, baseKnown, add[], update[], delete[], keep[], protected[], conflict[] }`.
- `--plan <file>` saves it instead of applying. The file pins the template commit, every decision with the hash of the template, base and vault file, and a digest of the vault's lock file. Plans from `--from working-tree` are refused, as they cannot be reproduced.
- `--apply <file>` runs the saved plan as written, with no selection flags. Before touching any vault it checks that the vault exists, that its lock is unchanged, and that every file the plan covers still has the hash it had when the plan was made. If anything differs, nothing is changed and the command exits 1 with a list. `--on-conflict` is chosen at apply time.

Writes are staged: every new file is first written next to its destination as `<name>.sync-tmp`. Only when all of them succeed are they renamed into place, deletions run, `community-plugins.json` is updated and the lock is written, last. A failure while staging removes the temp files and changes nothing.

## Roadmap

1. **Phase 1 (done):** tag source, lock, three-way reconcile with deletions, conflict policy, `--assume`, lock-aware compare.
2. **Phase 2 (done):** vault config `protect`, `exclude` and `pin`; `--plan <file>` / `--apply <file>`; staged writes.
3. **Phase 3 (done):** `migrations/<version>.ts` run in semver order and recorded in the lock; key-level `data.json` merge with the base from git; vault `patches`; release check for changelog migration entries.

## Known limitations

- `state.json` is read from the working tree, not from the source ref. An item removed from the template between versions is only cleaned up if it is still listed there.
- Renames during the final rename step are not transactional. If the process dies in the middle of it, rerunning sync completes the job (the lock is still the old one).
- `protect`, `exclude` and `patches` have no CLI flags; they come from the config files only.
- Migrations and patches run after the staged files are renamed, so they are not part of the all-or-nothing staging. They are idempotent, and the lock is written after them.
- The `data.json` merge needs the base tag in the checkout. Without it, differing keys are conflicts rather than silently resolved.
- Migrations are code from the template repo and run unsandboxed with the user's permissions. Only sync from a repo you trust.
