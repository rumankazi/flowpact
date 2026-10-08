/** Minimal glob: `*` matches within a segment, `**` across segments; plain strings match as path prefixes. */
export function matchesPattern(path: string, pattern: string): boolean {
  if (!pattern.includes('*'))
    return path === pattern || path.startsWith(pattern.endsWith('/') ? pattern : `${pattern}/`);
  const re = new RegExp(
    `^${pattern
      .split('**')
      .map((part) => part.split('*').map(escapeRe).join('[^/]*'))
      .join('.*')}$`,
  );
  return re.test(path);
}

const escapeRe = (s: string) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
