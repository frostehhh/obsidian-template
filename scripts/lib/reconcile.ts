import type { ConflictPolicy } from './types.ts';

// Per-file outcome of a three-way comparison between
//   t: the template source, b: the base recorded in the vault's lock, v: the vault.
// undefined means the file does not exist on that side.
export type Action = 'noop' | 'add' | 'update' | 'delete' | 'keep' | 'conflict' | 'protected';

// A protected path is never written or deleted: whatever sync would have done becomes 'protected'.
export function applyProtection(action: Action, isProtected: boolean): Action {
  if (!isProtected) return action;
  return action === 'add' || action === 'update' || action === 'delete' || action === 'conflict' ? 'protected' : action;
}

export function decide(t: string | undefined, b: string | undefined, v: string | undefined): Action {
  if (t === v) return 'noop';
  if (v === b) {
    // The vault did not change since the last sync, so the template change applies cleanly.
    if (t === undefined) return 'delete';
    return b === undefined ? 'add' : 'update';
  }
  // The vault changed locally.
  return t === b ? 'keep' : 'conflict';
}

export interface FileDecision {
  file: string;
  action: Action;
  templateHash: string | undefined;
  baseHash: string | undefined;
  vaultHash: string | undefined;
  // false for files outside the lock (plugin data files)
  tracked: boolean;
}

export type Effect = 'write' | 'delete' | 'none';

export interface Resolution {
  effect: Effect;
  // Base hash to record in the lock afterwards (undefined: not recorded)
  base: string | undefined;
  // Unresolved conflict: reported, and the conflict persists next run
  conflict: boolean;
}

// What to do with a decision under a conflict policy, and what the lock records afterwards.
export function resolve(d: FileDecision, policy: ConflictPolicy): Resolution {
  const { templateHash: t, baseHash: b } = d;
  switch (d.action) {
    case 'noop':
      return { effect: 'none', base: t, conflict: false };
    case 'add':
    case 'update':
      return { effect: 'write', base: t, conflict: false };
    case 'delete':
      return { effect: 'delete', base: undefined, conflict: false };
    case 'keep':
    case 'protected':
      return { effect: 'none', base: b, conflict: false };
    case 'conflict':
      if (policy === 'take-template') {
        return { effect: t === undefined ? 'delete' : 'write', base: t, conflict: false };
      }
      if (policy === 'keep-vault') return { effect: 'none', base: t, conflict: false };
      return { effect: 'none', base: b, conflict: true };
  }
}
