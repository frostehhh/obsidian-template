// JSON helpers for plugin data files: RFC 7386 merge patches and a key-level three-way merge.

export type JsonObject = { [key: string]: unknown };

export function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (isObject(a) && isObject(b)) {
    const keys = Object.keys(a);
    return keys.length === Object.keys(b).length && keys.every((k) => k in b && deepEqual(a[k], b[k]));
  }
  return false;
}

// RFC 7386: objects merge recursively, null deletes a key, anything else (arrays included) replaces.
export function mergePatch(target: unknown, patch: unknown): unknown {
  if (!isObject(patch)) return patch;
  const result: JsonObject = isObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) delete result[key];
    else result[key] = mergePatch(result[key], value);
  }
  return result;
}

export interface MergeConflict {
  path: string[];
  // The template's value; undefined when the template removed the key
  template: unknown;
}

export interface Merge3Result {
  // Result with every conflict resolved in favor of the vault
  merged: unknown;
  // Result with every conflict resolved in favor of the template
  mergedTemplate: unknown;
  conflicts: MergeConflict[];
}

// An array whose elements are all objects with a unique string "id" (QuickAdd choices, ...) merges element by element.
function keyedById(value: unknown): Map<string, JsonObject> | null {
  if (!Array.isArray(value)) return null;
  const map = new Map<string, JsonObject>();
  for (const item of value) {
    if (!isObject(item) || typeof item.id !== 'string' || map.has(item.id)) return null;
    map.set(item.id, item);
  }
  return map;
}

// Key-level three-way merge of base (the template as last synced), template (now) and vault.
// A side that did not change since the base never overrides the other. Objects merge key by key, and arrays of
// objects with unique ids merge by id (vault order first, new template elements appended). Other arrays and
// scalars are atomic. undefined means "absent".
export function merge3(base: unknown, template: unknown, vault: unknown): Merge3Result {
  const conflicts: MergeConflict[] = [];

  // preferTemplate only changes which side wins a conflict; conflicts are collected on the first pass
  function walk(b: unknown, t: unknown, v: unknown, path: string[], preferTemplate: boolean): unknown {
    if (deepEqual(t, v)) return v;
    if (deepEqual(t, b)) return v; // template unchanged: the vault's value stands
    if (deepEqual(v, b)) return t; // vault unchanged: take the template's change
    if (isObject(t) && isObject(v)) {
      const baseObject = isObject(b) ? b : {};
      const result: JsonObject = {};
      for (const key of [...Object.keys(v), ...Object.keys(t).filter((k) => !(k in v))]) {
        const value = walk(baseObject[key], t[key], v[key], [...path, key], preferTemplate);
        if (value !== undefined) result[key] = value;
      }
      return result;
    }
    const tm = keyedById(t);
    const vm = keyedById(v);
    const bm = b === undefined ? new Map<string, JsonObject>() : keyedById(b);
    if (tm && vm && bm) {
      const result: unknown[] = [];
      for (const id of [...vm.keys(), ...[...tm.keys()].filter((k) => !vm.has(k))]) {
        const value = walk(bm.get(id), tm.get(id), vm.get(id), [...path, id], preferTemplate);
        if (value !== undefined) result.push(value);
      }
      return result;
    }
    if (!preferTemplate) conflicts.push({ path, template: t });
    return preferTemplate ? t : v;
  }

  return {
    merged: walk(base, template, vault, [], false),
    mergedTemplate: walk(base, template, vault, [], true),
    conflicts,
  };
}

// Sets (or, with undefined, deletes) the value at a path inside a JSON object.
export function setPath(root: unknown, path: string[], value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string, ...string[]];
  const result: JsonObject = isObject(root) ? { ...root } : {};
  const next = setPath(result[head], rest, value);
  if (next === undefined) delete result[head];
  else result[head] = next;
  return result;
}

// Whether a merge patch says something about a path (so a conflict there is already decided by the vault owner).
export function patchCovers(patch: unknown, path: string[]): boolean {
  let current: unknown = patch;
  for (const key of path) {
    if (!isObject(current)) return true; // an ancestor is replaced wholesale
    if (!(key in current)) return false;
    current = current[key];
  }
  return true;
}

// Resolves a merge against a conflict policy: take-template applies the template's side of every conflict.
export function resolveMerge(merge: Merge3Result, takeTemplate: boolean): unknown {
  return takeTemplate ? merge.mergedTemplate : merge.merged;
}

// Writes JSON the way the original file was written (indent and trailing newline).
export function formatLike(sample: string, value: unknown): string {
  const indent = /^[{[]\r?\n([ \t]+)\S/.exec(sample)?.[1] ?? '  ';
  const newline = sample.endsWith('\n') ? '\n' : '';
  return `${JSON.stringify(value, null, indent)}${newline}`;
}
