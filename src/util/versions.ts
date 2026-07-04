/** Dotted-version helpers shared by the update checker and the GUI status. */

export const versionParts = (v: string): number[] =>
  v.replace(/^v/i, "").split(".").map((n) => Number.parseInt(n, 10) || 0);

/** "1.2.10" vs "1.2.9" — plain numeric segment compare, tolerant of a leading v. */
export function isNewer(latest: string, current: string): boolean {
  const [a, b] = [versionParts(latest), versionParts(current)];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d > 0;
  }
  return false;
}
