import { z } from "zod";

/**
 * Model-agnostic patch protocol: exact search/replace edits on decompiled
 * source. Far more reliable for small models than unified diffs (no line
 * numbers to drift), and trivially verifiable — a search string must match
 * exactly once or the edit is rejected.
 */

const EditSchema = z.object({
  file: z.string(),
  search: z.string().min(1),
  replace: z.string(),
});

const PatchSchema = z.object({
  edits: z.array(EditSchema).min(1),
  notes: z.string().optional(),
});

export type Patch = z.infer<typeof PatchSchema>;

/** Pulls the JSON payload out of a model response (fenced block or raw). */
export function parsePatch(response: string): { patch?: Patch; error?: string } {
  let raw = response.trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) raw = fenced[1].trim();
  if (!raw.startsWith("{")) {
    const start = raw.indexOf("{");
    const end = raw.lastIndexOf("}");
    if (start < 0 || end <= start) return { error: "no JSON object found in response" };
    raw = raw.slice(start, end + 1);
  }
  try {
    const parsed = PatchSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { error: `schema: ${parsed.error.issues.map((i) => i.message).join("; ")}` };
    return { patch: parsed.data };
  } catch (e) {
    return { error: `invalid JSON: ${e instanceof Error ? e.message : e}` };
  }
}

/** Applies edits to sources (keyed by internal class name). All-or-nothing. */
export function applyPatch(
  sources: Map<string, string>,
  patch: Patch,
): { applied?: Map<string, string>; errors: string[] } {
  const errors: string[] = [];
  const next = new Map(sources);

  for (const [i, edit] of patch.edits.entries()) {
    const fileKey = edit.file.replaceAll(".", "/").replace(/\.java$/, "");
    const src = next.get(fileKey);
    if (src === undefined) {
      errors.push(`edit ${i}: unknown file "${edit.file}" — provided files: ${[...sources.keys()].join(", ")}`);
      continue;
    }
    const occurrences = src.split(edit.search).length - 1;
    if (occurrences === 0) {
      errors.push(`edit ${i} (${edit.file}): search text not found — it must match the source EXACTLY, including whitespace`);
      continue;
    }
    if (occurrences > 1) {
      errors.push(`edit ${i} (${edit.file}): search text matches ${occurrences} times — add surrounding lines to make it unique`);
      continue;
    }
    next.set(fileKey, src.replace(edit.search, edit.replace));
  }

  return errors.length > 0 ? { errors } : { applied: next, errors: [] };
}
