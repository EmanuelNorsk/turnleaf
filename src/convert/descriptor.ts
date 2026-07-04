/** Minimal JVM method-descriptor parsing (e.g. "(Lorg/bukkit/Location;J)Z"). */

/** Split the parameter list of a method descriptor into JVM type tokens. */
export function parseParams(desc: string): string[] {
  const end = desc.indexOf(")");
  if (!desc.startsWith("(") || end < 0) throw new Error(`Invalid descriptor: ${desc}`);
  const params: string[] = [];
  let i = 1;
  while (i < end) {
    const start = i;
    while (desc[i] === "[") i++; // array dimensions
    if (desc[i] === "L") {
      i = desc.indexOf(";", i) + 1;
      if (i === 0) throw new Error(`Invalid descriptor: ${desc}`);
    } else {
      i++; // primitive
    }
    params.push(desc.slice(start, i));
  }
  return params;
}

/** Internal class name of the first parameter, or null if primitive/array/none. */
export function firstParamObject(desc: string): string | null {
  const params = parseParams(desc);
  if (params.length === 0) return null;
  const first = params[0];
  if (!first.startsWith("L")) return null;
  return first.slice(1, -1);
}

/** Descriptor with the first parameter removed (shim desc → original desc). */
export function dropFirstParam(desc: string): string {
  const params = parseParams(desc);
  const returnType = desc.slice(desc.indexOf(")") + 1);
  return `(${params.slice(1).join("")})${returnType}`;
}
