import { readFile, writeFile } from 'fs/promises';
import { join } from 'path';
import { makeVault, pathExists } from './cli.ts';
import { hashFile, itemPaths } from './compare.ts';
import { lockPath } from './lock.ts';
import { commitOf, gitSource, hashContent, WORKING_TREE } from './source.ts';
import { applyPlan, conflictLabel, countActions, verifyPlan } from './sync.ts';
import type { ItemPlan, SyncConflict, SyncPostReport, VaultExtras } from './sync.ts';
import type { FileDecision } from './reconcile.ts';
import type { ConflictPolicy, Item, TemplateSource, Vault } from './types.ts';

// A plan saved with --plan and executed later with --apply. It pins the exact template commit and the exact
// state of every file it touches, so applying it either does what was reviewed or refuses to run.

interface PlanFileItem {
  kind: Item['kind'];
  id: string;
  label: string;
  srcRel: string;
  baseKnown: boolean;
  addToCommunityPlugins: boolean;
  decisions: FileDecision[];
}

interface PlanFileVault {
  name: string;
  root: string;
  source: { ref: string; version: string; commit: string };
  // Hash of the vault's lock file when the plan was made ("none" when it had no lock)
  lockDigest: string;
  items: PlanFileItem[];
  // Migrations to run (loaded from the pinned commit), what to record afterwards, and the vault's patches
  migrations: string[];
  record: string[];
  patches: Record<string, unknown>;
}

export interface PlanFile {
  planVersion: 1;
  vaults: PlanFileVault[];
}

export interface PlannedVault {
  vault: Vault;
  source: TemplateSource;
  plan: ItemPlan[];
  extras: VaultExtras;
}

async function lockDigest(vault: Vault): Promise<string> {
  try {
    return hashContent(await readFile(lockPath(vault)));
  } catch {
    return 'none';
  }
}

export async function writePlanFile(path: string, planned: PlannedVault[]): Promise<PlanFile> {
  const vaults: PlanFileVault[] = [];
  for (const { vault, source, plan, extras } of planned) {
    if (source.ref === WORKING_TREE) {
      throw new Error('A plan must reference a tagged version or commit, not the working tree. Use --from <ref>.');
    }
    vaults.push({
      name: vault.name,
      root: vault.root,
      source: { ref: source.ref, version: source.version, commit: commitOf(source.ref) },
      lockDigest: await lockDigest(vault),
      items: plan
        .filter((entry) => entry.vault.name === vault.name)
        .map((entry) => ({
          kind: entry.item.kind,
          id: entry.item.id,
          label: entry.item.label,
          srcRel: entry.srcRel,
          baseKnown: entry.baseKnown,
          addToCommunityPlugins: entry.addToCommunityPlugins,
          decisions: entry.decisions,
        })),
      migrations: extras.migrations,
      record: extras.record,
      patches: extras.patches,
    });
  }
  const file: PlanFile = { planVersion: 1, vaults };
  await writeFile(path, `${JSON.stringify(file, null, 2)}\n`);
  return file;
}

export async function readPlanFile(path: string): Promise<PlanFile> {
  const parsed = JSON.parse(await readFile(path, 'utf8')) as PlanFile;
  if (parsed.planVersion !== 1) throw new Error(`${path}: unsupported planVersion ${String(parsed.planVersion)}`);
  return parsed;
}

export class StalePlanError extends Error {
  problems: string[];
  constructor(problems: string[]) {
    super(`The plan is stale, nothing was changed. Make a new plan with --plan.\n${problems.map((p) => `  ${p}`).join('\n')}`);
    this.problems = problems;
  }
}

export interface AppliedVault {
  vault: Vault;
  source: TemplateSource;
  plan: ItemPlan[];
  conflicts: SyncConflict[];
  notes: string[];
  postReport: SyncPostReport | undefined;
}

// Applies a saved plan exactly as written. Every vault is validated before any vault is touched.
export async function applyPlanFile(path: string, policy: ConflictPolicy): Promise<AppliedVault[]> {
  const file = await readPlanFile(path);
  const prepared: { vault: Vault; source: TemplateSource; plan: ItemPlan[]; extras: VaultExtras }[] = [];
  const problems: string[] = [];

  for (const entry of file.vaults) {
    const vault = makeVault(entry.name, entry.root);
    if (!(await pathExists(join(vault.root, '.obsidian')))) {
      problems.push(`${entry.name}: vault not found at ${entry.root}`);
      continue;
    }
    if ((await lockDigest(vault)) !== entry.lockDigest) {
      problems.push(`${entry.name}: the lock file changed since the plan was made`);
      continue;
    }

    const source = gitSource(entry.source.commit, entry.source.version);
    const plan: ItemPlan[] = [];
    for (const item of entry.items) {
      const { destRoot } = itemPaths({ kind: item.kind, id: item.id, label: item.label }, vault);
      for (const d of item.decisions) {
        let current: string | undefined;
        try {
          current = await hashFile(join(destRoot, d.file));
        } catch {
          current = undefined;
        }
        if (current !== d.vaultHash) problems.push(`${entry.name}: ${item.kind} ${item.id}: ${d.file || item.id} changed since the plan was made`);
      }
      plan.push({
        vault,
        item: { kind: item.kind, id: item.id, label: item.label },
        srcRel: item.srcRel,
        destRoot,
        decisions: item.decisions,
        baseKnown: item.baseKnown,
        addToCommunityPlugins: item.addToCommunityPlugins,
      });
    }
    const extras: VaultExtras = { vault, migrations: entry.migrations, record: entry.record, patches: entry.patches };
    for (const version of extras.migrations) {
      if (!(await source.listRepo('migrations')).includes(`${version}.ts`)) {
        problems.push(`${entry.name}: migration ${version} is missing from template ${entry.source.version}`);
      }
    }
    prepared.push({ vault, source, plan, extras });
  }

  if (problems.length > 0) throw new StalePlanError(problems);

  const applied: AppliedVault[] = [];
  for (const { vault, source, plan, extras } of prepared) {
    const { conflicts, notes } = await applyPlan(plan, source, policy, [extras]);
    const [postReport] = await verifyPlan(plan, source);
    applied.push({ vault, source, plan, conflicts, notes, postReport });
  }
  return applied;
}

export function appliedToJson(applied: AppliedVault[]) {
  return applied.map(({ vault, source, plan, conflicts, notes, postReport }) => ({
    vault: vault.name,
    templateVersion: source.label,
    actions: countActions(plan),
    allMatch: postReport?.results.every((r) => r.status === 'in sync') ?? true,
    conflicts: conflicts.map((c) => ({ kind: c.item.kind, id: c.item.id, file: c.file, detail: c.detail })),
    notes: notes,
  }));
}

export function renderApplied(applied: AppliedVault[]): string {
  const lines: string[] = [];
  for (const { vault, source, plan, conflicts, notes, postReport } of applied) {
    lines.push(`${vault.name} (template ${source.label}): ${summarizePlan(plan)}`);
    const notMatching = postReport?.results.filter((r) => r.status !== 'in sync') ?? [];
    for (const r of notMatching) lines.push(`    ${r.kind} ${r.label}: ${r.status}`);
    for (const c of conflicts) lines.push(`    conflict: ${c.item.kind} ${c.item.label}: ${conflictLabel(c)}`);
    for (const note of notes) lines.push(`    ${note}`);
  }
  return lines.join('\n');
}

// One line per vault: "name: 3 add, 1 update, ...".
export function summarizePlan(plan: ItemPlan[]): string {
  const c = countActions(plan);
  return `${c.add} add, ${c.update} update, ${c.delete} delete, ${c.keep} keep, ${c.protected} protected, ${c.conflict} conflict`;
}
