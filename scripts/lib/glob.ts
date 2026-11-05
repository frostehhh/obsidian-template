// Minimal glob matching for vault-relative paths (always "/" separated).
//   *   any characters except "/"
//   **  any characters including "/" ("dir/**" matches everything below dir)
//   ?   one character except "/"
// A trailing "/" is shorthand for "/**". Matching is case-sensitive and anchored at the vault root.

export function globToRegExp(glob: string): RegExp {
  const pattern = glob.endsWith('/') ? `${glob}**` : glob;
  let source = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i] as string;
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        i += 1;
        if (pattern[i + 1] === '/') {
          i += 1;
          source += '(?:.*/)?'; // "**/" also matches zero directories
        } else {
          source += '.*';
        }
      } else {
        source += '[^/]*';
      }
    } else if (c === '?') {
      source += '[^/]';
    } else {
      source += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${source}$`);
}

export function createMatcher(globs: string[]): (path: string) => boolean {
  const patterns = globs.map(globToRegExp);
  return (path) => patterns.some((p) => p.test(path));
}
