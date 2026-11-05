# Migrations

A migration carries an existing vault to a release when plain file sync cannot: renaming a key inside a plugin's `data.json`, moving a file the user owns, removing a setting. Sync runs them; nobody has to follow changelog steps by hand.

## When to write one

Every changelog entry with a **Migration** note needs either `migrations/<version>.ts` (the version being released) or `<!-- migrations: none -->` in the changelog, meaning the steps are manual. `mise run release` refuses otherwise.

You do not need a migration for template files that changed, were added or were removed. Sync's three-way comparison handles those. A plugin's `data.json` is merged key by key with `--data-json`, so ordinary setting changes do not need one either.

## File format

`migrations/<x.y.z>.ts` exports `description` and `run(ctx)`:

```ts
import type { MigrationContext } from '../scripts/lib/migrations.ts';

export const description = 'Rename the QuickAdd macros';

export async function run(ctx: MigrationContext): Promise<void> {
  const changed = await ctx.patchJson('.obsidian/plugins/quickadd/data.json', { persistInputPromptDrafts: false });
  ctx.log(changed ? 'updated data.json' : 'data.json already up to date');
  await ctx.rename('Notes/Old name.md', 'Notes/New name.md');
}
```

Rules:

- **Self-contained.** Only `import type` is allowed. The file is read from the git tag being synced and run from a temp directory, so relative imports do not resolve.
- **Idempotent.** Running it twice must change nothing the second time. If it fails halfway, the next sync runs it again from the start.
- **Only through `ctx`.** Paths are relative to the vault and cannot leave it. Writes, renames and removals of paths matched by the vault's `protect` globs are skipped and logged.

`ctx` offers `exists`, `readText`, `writeText`, `readJson`, `writeJson`, `patchJson` (RFC 7386 merge patch, `null` deletes a key; returns whether the file changed), `rename`, `remove` and `log`.

## When they run

After a sync has put the files in place and before the lock is written. For each vault, sync runs the migrations of the version it syncs to (and every earlier one the vault has not run yet), oldest first, and records them in the vault's `template.lock.json`.

- A vault whose lock was written before migrations existed counts as being at the oldest version of any item in the lock.
- A vault with no lock runs nothing and records every migration up to the target as done, as it starts from the current template. Use `--assume <version>` to say which version it is really at.
- Syncing an older tag never un-runs a migration.
- `--dry-run` and `--plan` list the migrations that would run.

To test one before releasing, put the file in `migrations/` and run `sync --from working-tree` against a throwaway vault. Delete the test file afterwards.
