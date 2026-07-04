/**
 * Small line-based unified diff (LCS with common prefix/suffix trimming) for
 * the "what changed?" viewer. Good enough for decompiled classes; not a
 * general-purpose diff.
 */
export function unifiedDiff(before: string, after: string, context = 3): string {
  const a = before.split(/\r?\n/);
  const b = after.split(/\r?\n/);

  // Trim the common prefix/suffix — conversions touch a few methods, so the
  // interesting middle is small even for big classes.
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);

  if (midA.length === 0 && midB.length === 0) return "(no textual difference after decompilation)";

  // ops over the middle: arrays of [type, line]
  let ops: ["=" | "-" | "+", string][];
  if (midA.length * midB.length > 4_000_000) {
    // Too large for LCS — degrade to a block replacement.
    ops = [...midA.map((l): ["-", string] => ["-", l]), ...midB.map((l): ["+", string] => ["+", l])];
  } else {
    const n = midA.length;
    const m = midB.length;
    const dp = new Uint32Array((n + 1) * (m + 1));
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        dp[i * (m + 1) + j] =
          midA[i] === midB[j] ? dp[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(dp[(i + 1) * (m + 1) + j], dp[i * (m + 1) + j + 1]);
      }
    }
    ops = [];
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
      if (midA[i] === midB[j]) {
        ops.push(["=", midA[i]]);
        i++;
        j++;
      } else if (dp[(i + 1) * (m + 1) + j] >= dp[i * (m + 1) + j + 1]) {
        ops.push(["-", midA[i++]]);
      } else {
        ops.push(["+", midB[j++]]);
      }
    }
    while (i < n) ops.push(["-", midA[i++]]);
    while (j < m) ops.push(["+", midB[j++]]);
  }

  // Render with limited context around changes (prefix/suffix already trimmed,
  // so add up to `context` lines from them).
  const out: string[] = [];
  const pre = a.slice(Math.max(0, start - context), start);
  if (start - context > 0) out.push("  …");
  out.push(...pre.map((l) => `  ${l}`));

  let eqRun: string[] = [];
  const flushEq = (last: boolean) => {
    if (eqRun.length <= context * 2 + 1) {
      out.push(...eqRun.map((l) => `  ${l}`));
    } else {
      out.push(...eqRun.slice(0, context).map((l) => `  ${l}`));
      out.push("  …");
      if (!last) out.push(...eqRun.slice(-context).map((l) => `  ${l}`));
    }
    eqRun = [];
  };
  for (const [type, line] of ops) {
    if (type === "=") eqRun.push(line);
    else {
      flushEq(false);
      out.push(`${type} ${line}`);
    }
  }
  flushEq(true);

  out.push(...b.slice(endB, Math.min(b.length, endB + context)).map((l) => `  ${l}`));
  if (endB + context < b.length) out.push("  …");
  return out.join("\n");
}
