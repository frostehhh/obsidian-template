---
name: obsidian-template-vault-update
description: Update an existing Obsidian vault (Odyssey, Journal, ...) with changes from this template repo, by comparing the vault with the commits since its last recorded update and applying them per feature. Use when asked to sync, update or upgrade a vault from the template, bring a new QuickAdd script or choice into a vault, check what a vault is missing, configure what a vault takes from the template, or migrate a vault's v1 template.lock.json. Replaces the DRAFT mise run sync.
---

# Obsidian Template Vault Update

You update a vault from the commit it was last recorded at (the **base**) to a **target** commit. The default target is the latest `v*` tag, or `--to HEAD` when the user asks for unreleased changes.

The scripts collect the facts and do the writing. You present the changes and the user decides each one. The design is in `docs/specs/vault-update.md`.

| Command | Writes |
|---|---|
| `mise run vault-update:report <vault> [--to <ref>] [--json] [--all] [--scope] [--audit] [--base <ref>]` | nothing |
| `mise run vault-update:apply <vault> --entry '<id>'... \| --all [--take-template '<id>'] [--to <ref>] [--dry-run]` | vault files only |
| `mise run vault-update:record <vault> --commit <ref> [--keep\|--defer '<id>'] [--decline '<key>[=label]'] [--save-scope]` | lock and vault config |

`<vault>` is a sibling vault name (`Journal`) or a path.

Pass the same `--to` to report and apply. Pass the same commit to record as `--commit`.

Entry ids are `path`, or `path#key` for a JSON key. Always single-quote them, because they contain `[`, `]` and `#`.

Run `report --json` to get the exact ids: `entries[].id`, `state`, `label`, `refs` and `commits`.

Never write `.obsidian/template.lock.json` or the vault's `decline` or `default*` keys by hand. `record` writes them.

Never use `mise run sync` or `agent:sync`. They are DRAFT and drop changes.

## Workflow

### 1. Preflight

Run `git -C <vault> status --short`. The report header also shows `git: clean | dirty | not a repo`.

- **Dirty:** ask the user to commit or stash first, so every change can be reviewed with `git diff` and reverted.
- **Not a repo:** warn the user that nothing can be undone, and get explicit confirmation before going on.

### 2. Scope

Do this on the first update, when the vault has no `.obsidian/sync.config.json` (or no `default*` keys in it), or when the user asks.

1. Run `report <vault> --scope`. For each plugin, directory and setting it shows:
   - whether it is selected
   - where the current selection comes from: `cli`, `vault config`, `lock` or `repo config`
   - its status against the target
   - which directories are linked to a plugin
2. Ask the sync wizard's three questions with the question tool, preselecting the current values:
   - Which plugins?
   - Which directories? Mention that linked directories come with their plugin: QuickAdd → `--Configurations--/Scripts`, Excalidraw → `Excalidraw`, and so on.
   - Which settings?
3. Save the answers: `record <vault> --save-scope --plugins a,b --dirs X,Y --settings s`. Only the three `default*` keys change.

`syncDataJson: true` in the config means auto-approve plugin `data.json` keys that match the old state (`apply (auto)`). Ask the user whether they want that.

### 3. Report

Run `report <vault> [--to <ref>]`. If the header says `lock: v1`, follow "Migrating a v1 lock" below first.

Present the report to the user per group, in order. A group is one commit, with its changelog line, and it usually is one feature, such as a script plus its QuickAdd choice. For each group, show:

- what it does (from the changelog)
- the entries and their states:
  - `apply`: the vault still has the old state
  - `apply (auto)`
  - `apply (no base)`: the vault lacks the item and there is no base
  - `conflict`: the vault differs from both the old and the new state
  - `rename`: the file moved, and applying it moves the vault's file
- `done` entries as a count only

Also report, if present:

- **Dependency warnings**, for example a choice that needs a script the vault will not have.
- **Migrations**, which you run by hand: read `migrations/<x.y.z>.ts` and the changelog `**Migration**` note, explain the steps, and carry them out after confirmation.
- **Stale declines.** Offer to remove them with `record ... --drop-decline '<key>'`.
- **Deselected items.** Their files are left in place; offer to delete them only if the user asks.
- **Available items.** Mention them. Adding one is a scope change (step 2).
- **Not enabled plugins**, which are missing from `community-plugins.json`.

### 4. Decide

Ask per group with the question tool. Ask per entry only if the user wants to split a group. The choices are:

- **Apply**: take the change.
- **Defer**: not now, offer it again next time.
- **Decline**: never offer it. It is stored in the vault config with a label.
- **Keep**: conflicts only. Keep the vault's version this time.

`apply (auto)` entries need no question, but list them in the summary.

Before you go on, warn about any split dependency. A declined script with an applied choice that runs it, or the reverse, leaves the vault broken.

For a text conflict, offer a 3-way merge. Use the `old` and `new` hashes from `report --json`:

```sh
git cat-file blob <old> > /tmp/old; git cat-file blob <new> > /tmp/new
git merge-file -p "<vault>/<path>" /tmp/old /tmp/new > /tmp/merged   # exit code = number of conflict blocks
```

Show the merged result. Write it to the vault only if the user accepts it, and resolve any conflict markers with them. The entry stays a conflict, so record it with `--keep`.

For a JSON key conflict, show the vault and template values (`git cat-file blob <new>`, then read the key), and ask which value to keep.

### 5. Apply

Run with `--dry-run` first, then for real:

```sh
mise run vault-update:apply <vault> --to <ref> --entry '<id>' --entry '<id>' [--take-template '<conflict id>']
mise run vault-update:apply <vault> --to <ref> --all     # every apply / apply (auto) / apply (no base) entry
```

Apply writes exact template blobs, moves files, removes directories left empty, and sets or removes JSON keys while keeping the file's indentation. It also adds newly installed plugins to `community-plugins.json`. It refuses conflicts that are not passed with `--take-template`, and it refuses declined and protected entries.

### 6. Verify

Run `report` again. Every entry must now be `done`, or one the user chose to keep, defer or decline.

### 7. Record

```sh
mise run vault-update:record <vault> --commit <same ref as --to> \
  --keep '<conflict id>' --defer '<id>' --decline '<id or glob or path#key>=<label>'
```

- For long lists, use `--decisions file.json` with `{ "keep": [], "defer": [], "decline": { "<key>": "<label>" } }`.
- A decline can be wider than one entry, such as `Notes/**`, or a key prefix such as `data.json#choices[<id>]`. The label defaults to the QuickAdd choice name.
- Record refuses, and writes nothing, if any open entry has no decision, or if a decision names a wrong entry. Fix the list and run it again.
- Run `--dry-run` first to show the lock and config changes.

### 8. Hand over

Show `git -C <vault> status --short` and `git -C <vault> diff --stat`. The user commits the vault. Do not commit it yourself unless they ask.

## Migrating a v1 lock

Vaults synced by the draft have `lockVersion: 1`, with versions per item that can be `working-tree`. The first update migrates the lock:

1. The report finds a base per item:
   - A tag version uses that tag.
   - `working-tree` uses the newest template commit whose files match the lock's recorded hashes exactly, shown as `hash-match <sha>`.
   - `NO EXACT MATCH, closest <sha> (n/m)`: show it and ask the user whether to accept that commit, by passing `--base <sha>` to report, apply and record, or to go on with no base, where those items are compared with the target only.
2. Without a base, a plugin `data.json` (no `dataVersion`, or `working-tree`) is compared key by key with the target:
   - keys the vault lacks are `apply (no base)`
   - keys that differ are conflicts
   - keys only the vault has are never touched

   With many conflicts, the vault's own settings usually win. Offer keep for all the conflicts as one choice, and list any that look like template features (QuickAdd choices, script paths).
3. Without a vault config, the scope comes from the v1 lock's items. Offer step 2 (Scope) and save it.
4. Decide, apply and verify as usual. `record` backs up the old lock to `.obsidian/template.lock.v1.json` and writes v2.

To convert a lock without taking any template changes, make sure every item resolves to the same commit, then run `report --to <that commit>` and `record --commit <that commit>`. When items resolve to different commits, the conversion needs one target that they all share, usually the latest tag.

## Examples

**Journal.** v1 lock, every item at 0.4.0, QuickAdd has no `dataVersion`.

- The base is `v0.4.0`.
- Each script added since then is a group of `apply add <script>` plus `apply (no base) add data.json choices[<id>]` for its choice.
- Choices from earlier releases that Journal never received also show up as `apply (no base)`.
- Apply the groups the user wants, then `record Journal --commit <target>`.

**Odyssey.** v1 lock, every item at `working-tree`, no vault config.

- Bases come from `hash-match`, per item.
- The scope comes from the lock. Offer to save it.
- Plugin `data.json` conflicts are the vault's own settings. Keep them unless the user says otherwise.
- QuickAdd choices that only Odyssey has, such as `createCompetency`, are never touched.

## Safety

- Files that exist only in the vault, and keys that exist only in the vault, are never touched.
- `protect` paths show as `protected` and are never written.
- `exclude` items are never in scope.
- One target per run: the `--to` given to report and apply, and `--commit` given to record, must name the same commit.
