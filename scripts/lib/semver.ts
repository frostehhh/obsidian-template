// Just enough semver for template tags (vX.Y.Z) and vault pins.
// Supported ranges: exact ("0.3.1"), wildcard ("0.2.x", "0.x", "*"), caret ("^0.3.0") and tilde ("~0.3.0").

export type Version = [number, number, number];

export function parseVersion(input: string): Version | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(input.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function compareVersions(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) {
    const d = (a[i] as number) - (b[i] as number);
    if (d !== 0) return d;
  }
  return 0;
}

interface Bounds {
  min: Version;
  // exclusive upper bound; null: unbounded
  max: Version | null;
}

export function parseRange(range: string): Bounds | null {
  const text = range.trim();
  if (text === '*' || text.toLowerCase() === 'x') return { min: [0, 0, 0], max: null };

  const op = text.startsWith('^') ? '^' : text.startsWith('~') ? '~' : '';
  const parts = text.slice(op.length).replace(/^v/, '').split('.');
  if (parts.length === 0 || parts.length > 3) return null;

  const nums: number[] = [];
  for (const part of parts) {
    if (/^[xX*]$/.test(part)) break;
    if (!/^\d+$/.test(part)) return null;
    nums.push(Number(part));
  }
  if (nums.length === 0) return null;

  const [major = 0, minor = 0, patch = 0] = nums;
  const min: Version = [major, minor, patch];

  if (op === '^') {
    if (major > 0) return { min, max: [major + 1, 0, 0] };
    if (minor > 0 || nums.length < 3) return { min, max: [0, minor + 1, 0] };
    return { min, max: [0, 0, patch + 1] };
  }
  if (op === '~') {
    if (nums.length === 1) return { min, max: [major + 1, 0, 0] };
    return { min, max: [major, minor + 1, 0] };
  }
  // Exact or wildcard: the fixed leading numbers define the range.
  if (nums.length === 3) return { min, max: [major, minor, patch + 1] };
  if (nums.length === 2) return { min, max: [major, minor + 1, 0] };
  return { min, max: [major + 1, 0, 0] };
}

export function isValidRange(range: string): boolean {
  return parseRange(range) !== null;
}

export function satisfies(version: string, range: string): boolean {
  const v = parseVersion(version);
  const bounds = parseRange(range);
  if (!v || !bounds) return false;
  return compareVersions(v, bounds.min) >= 0 && (bounds.max === null || compareVersions(v, bounds.max) < 0);
}

// Highest tag (vX.Y.Z) within the range, or null.
export function pickTag(tags: string[], range: string): string | null {
  let best: { tag: string; version: Version } | null = null;
  for (const tag of tags) {
    const version = parseVersion(tag);
    if (!version || !satisfies(tag, range)) continue;
    if (!best || compareVersions(version, best.version) > 0) best = { tag, version };
  }
  return best?.tag ?? null;
}
