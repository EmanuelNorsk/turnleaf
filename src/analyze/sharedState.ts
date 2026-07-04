import type { EngineIndex, IndexedClass, IndexedMethod, Invocation, RegionViolation } from "../types.js";
import { subclassesOf } from "../scan/scanner.js";
import { parseParams } from "../convert/descriptor.js";
import { loadRegionCatalog } from "./regionCatalog.js";

/**
 * Shared-mutable-state detector (M3, deterministic).
 *
 * On Paper, event handlers and sync tasks all ran on one thread, so plain
 * HashMaps were safe. On Folia they run on many region threads concurrently.
 * This analysis classifies each method into execution contexts, propagates
 * contexts through the jar-internal call graph, and reports fields that are
 * mutated from concurrent contexts.
 */

export type Context = "EVENT" | "COMMAND" | "TASK_SYNC" | "TASK_ASYNC" | "STARTUP";

/** Contexts that are concurrent with themselves on Folia (many threads). */
const SELF_CONCURRENT: ReadonlySet<Context> = new Set(["EVENT", "COMMAND", "TASK_ASYNC"]);

const EVENT_HANDLER_ANNOTATION = "Lorg/bukkit/event/EventHandler;";
const BUKKIT_RUNNABLE = "org/bukkit/scheduler/BukkitRunnable";
const SCHEDULER_METHOD_NAMES = new Set([
  "runTask",
  "runTaskLater",
  "runTaskTimer",
  "runTaskAsynchronously",
  "runTaskLaterAsynchronously",
  "runTaskTimerAsynchronously",
  "scheduleSyncDelayedTask",
  "scheduleSyncRepeatingTask",
  "scheduleAsyncDelayedTask",
  "scheduleAsyncRepeatingTask",
]);

const UNSAFE_CONCRETE = new Set(
  [
    "java/util/HashMap",
    "java/util/LinkedHashMap",
    "java/util/TreeMap",
    "java/util/WeakHashMap",
    "java/util/EnumMap",
    "java/util/ArrayList",
    "java/util/LinkedList",
    "java/util/HashSet",
    "java/util/LinkedHashSet",
    "java/util/TreeSet",
    "java/util/ArrayDeque",
    "java/util/PriorityQueue",
    "java/util/BitSet",
    "java/lang/StringBuilder",
  ].map((t) => `L${t};`),
);

const COLLECTION_INTERFACES = new Set(
  ["java/util/Map", "java/util/List", "java/util/Set", "java/util/Collection", "java/util/Queue", "java/util/Deque"].map(
    (t) => `L${t};`,
  ),
);

const CONCURRENT_SAFE_PREFIXES = ["Ljava/util/concurrent/", "Ljava/util/concurrent/atomic/"];

/** Method names that mutate a collection's contents. */
const COLLECTION_MUTATORS = new Set([
  "put", "putAll", "putIfAbsent", "remove", "removeAll", "removeIf", "add", "addAll", "clear",
  "set", "sort", "merge", "compute", "computeIfAbsent", "computeIfPresent", "replace", "replaceAll",
  "poll", "pollFirst", "pollLast", "offer", "offerFirst", "offerLast", "push", "pop",
  "addFirst", "addLast", "removeFirst", "removeLast", "retainAll",
]);

/** How far back (in interesting-instruction order) a mutator binds to a field read. */
const MUTATOR_BIND_WINDOW = 8;

/** Parameter types that can carry a task body into a scheduling abstraction. */
const FUNCTIONAL_PARAM_TYPES = new Set([
  "Ljava/lang/Runnable;",
  "Ljava/util/concurrent/Callable;",
  "Ljava/util/function/Consumer;",
  "Ljava/util/function/Supplier;",
  "Ljava/util/function/Function;",
  "Lorg/bukkit/scheduler/BukkitRunnable;",
]);

const FUNCTIONAL_INTERFACES = new Set([
  "java/lang/Runnable",
  "java/util/concurrent/Callable",
  "java/util/function/Consumer",
  "java/util/function/Supplier",
  "java/util/function/Function",
]);

const EXECUTOR_METHOD_NAMES = new Set([
  "execute",
  "submit",
  "schedule",
  "scheduleAtFixedRate",
  "scheduleWithFixedDelay",
]);

const ACC_STATIC = 0x0008;
const ACC_VOLATILE = 0x0040;
const ACC_SYNTHETIC = 0x1000;

export interface SharedFieldFinding {
  owner: string;
  field: string;
  desc: string;
  isStatic: boolean;
  isVolatile: boolean;
  contexts: Context[];
  reads: number;
  writes: number;
  risk: "high" | "medium" | "low";
  sampleSites: string[];
  suggestion: string;
}

export interface AnalysisResult {
  jar: string;
  methodsWithContext: number;
  findings: SharedFieldFinding[];
  regionViolations: RegionViolation[];
}

/**
 * Contexts that don't own a spatial entity/block's region, so a region-locked
 * mutation there throws on Folia: async threads, the global scheduler (where
 * Tier 1 routes "sync" tasks), and command dispatch. EVENT is excluded — Folia
 * fires events on the owning region thread, so those are usually fine.
 */
const OFF_REGION: ReadonlySet<Context> = new Set(["TASK_ASYNC", "TASK_SYNC", "COMMAND"]);

/** Getter-style reads are region-locked but rarely crash; mutations definitely do. */
const READ_METHOD = /^(get|is|has|can)[A-Z]/;

/** No-arg method returning a value is a getter (e.g. Paper's fluent customName()). */
function isReadCall(name: string, desc: string): boolean {
  if (READ_METHOD.test(name)) return true;
  return desc.startsWith("()") && !desc.endsWith(")V");
}

const key = (cls: string, name: string, desc: string) => `${cls}#${name}${desc}`;

export function analyzeSharedState(index: EngineIndex, ignorePrefixes: string[] = []): AnalysisResult {
  const classes = index.classes.filter((c) => !ignorePrefixes.some((p) => c.name.startsWith(p)));
  const classMap = new Map<string, IndexedClass>(classes.map((c) => [c.name, c]));
  const methodMap = new Map<string, { cls: IndexedClass; method: IndexedMethod }>();
  for (const cls of classes) {
    for (const m of cls.methods) methodMap.set(key(cls.name, m.name, m.desc), { cls, method: m });
  }

  const runnableSubclasses = subclassesOf(index, BUKKIT_RUNNABLE);

  // ---- 1. Roots: methods with a known execution context ----
  const contexts = new Map<string, Set<Context>>();
  const addCtx = (k: string, ctx: Context): boolean => {
    let set = contexts.get(k);
    if (!set) contexts.set(k, (set = new Set()));
    if (set.has(ctx)) return false;
    set.add(ctx);
    return true;
  };

  // How each BukkitRunnable subclass is scheduled (sync/async), from call sites.
  const runnableAsync = new Map<string, boolean>();
  for (const cls of classes) {
    for (const m of cls.methods) {
      for (const inv of m.invocations) {
        if (!inv.handle && runnableSubclasses.has(inv.owner) && SCHEDULER_METHOD_NAMES.has(inv.name)) {
          const async = /Async/.test(inv.name);
          runnableAsync.set(inv.owner, (runnableAsync.get(inv.owner) ?? false) || async);
        }
      }
    }
  }

  for (const cls of classes) {
    const isCommandExecutor = cls.interfaces.some(
      (i) => i === "org/bukkit/command/CommandExecutor" || i === "org/bukkit/command/TabExecutor",
    );
    for (const m of cls.methods) {
      const k = key(cls.name, m.name, m.desc);
      if (m.annotations.includes(EVENT_HANDLER_ANNOTATION)) addCtx(k, "EVENT");
      if (isCommandExecutor && (m.name === "onCommand" || m.name === "onTabComplete")) addCtx(k, "COMMAND");
      if ((m.name === "onEnable" || m.name === "onDisable" || m.name === "onLoad") && m.desc === "()V") {
        addCtx(k, "STARTUP");
      }
      if (runnableSubclasses.has(cls.name) && m.name === "run" && m.desc === "()V") {
        addCtx(k, runnableAsync.get(cls.name) ? "TASK_ASYNC" : "TASK_SYNC");
      }
    }
  }

  // ---- 1b. Scheduling sinks: real schedulers, executors, and — crucially —
  // the plugin's OWN abstractions over them (TaskManager-style wrappers),
  // resolved to fixpoint so wrappers-of-wrappers are followed too. ----

  /** async=true / sync=false for known external sinks; null = not a sink. */
  const seedSinkAsync = (inv: Invocation): boolean | null => {
    if (
      SCHEDULER_METHOD_NAMES.has(inv.name) &&
      (inv.owner === "org/bukkit/scheduler/BukkitScheduler" ||
        inv.owner === BUKKIT_RUNNABLE ||
        runnableSubclasses.has(inv.owner))
    ) {
      return /Async/.test(inv.name);
    }
    if (inv.owner.startsWith("java/util/concurrent/")) {
      if (EXECUTOR_METHOD_NAMES.has(inv.name)) return true;
      if (inv.owner === "java/util/concurrent/CompletableFuture" && (inv.name === "runAsync" || inv.name === "supplyAsync" || inv.name.endsWith("Async"))) {
        return true;
      }
    }
    if (inv.owner === "java/lang/Thread" && inv.name === "<init>" && inv.desc.includes("Ljava/lang/Runnable;")) {
      return true;
    }
    return null;
  };

  const hasFunctionalParam = (desc: string): boolean =>
    parseParams(desc).some((p) => FUNCTIONAL_PARAM_TYPES.has(p) || (p.startsWith("L") && classMap.has(p.slice(1, -1))));

  // Jar-internal sinks: methods with a task-shaped parameter whose body
  // (transitively) reaches a real scheduler/executor. async dominates.
  const jarSinks = new Map<string, boolean>();
  let sinksChanged = true;
  while (sinksChanged) {
    sinksChanged = false;
    for (const cls of classes) {
      for (const m of cls.methods) {
        const k = key(cls.name, m.name, m.desc);
        if (jarSinks.get(k) === true) continue; // already at strongest classification
        if (!hasFunctionalParam(m.desc)) continue;
        let async: boolean | null = jarSinks.has(k) ? jarSinks.get(k)! : null;
        for (const inv of m.invocations) {
          if (inv.handle) continue;
          const s = seedSinkAsync(inv) ?? jarSinks.get(key(inv.owner, inv.name, inv.desc)) ?? null;
          if (s !== null) async = (async ?? false) || s;
        }
        if (async !== null && async !== (jarSinks.has(k) ? jarSinks.get(k) : null)) {
          jarSinks.set(k, async);
          sinksChanged = true;
        }
      }
    }
    // Interface/superclass methods dispatch to implementations: if an impl is
    // a sink, calls through the declared type must count too.
    for (const cls of classes) {
      for (const m of cls.methods) {
        const implKey = key(cls.name, m.name, m.desc);
        const implAsync = jarSinks.get(implKey);
        if (implAsync === undefined) continue;
        const declaredOn = [...cls.interfaces, cls.superName ?? ""].filter((n) => classMap.has(n));
        for (const decl of declaredOn) {
          const declKey = key(decl, m.name, m.desc);
          if (jarSinks.get(declKey) !== true && (jarSinks.get(declKey) ?? null) !== implAsync) {
            jarSinks.set(declKey, (jarSinks.get(declKey) ?? false) || implAsync);
            sinksChanged = true;
          }
        }
      }
    }
  }

  // Task-body classes: jar classes implementing Runnable/Callable/etc. —
  // their instances can be handed to sinks like lambdas are.
  const functionalImpls = new Map<string, string[]>(); // class → body method keys
  for (const cls of classes) {
    const chain: string[] = [];
    let cur: IndexedClass | undefined = cls;
    while (cur) {
      chain.push(...cur.interfaces);
      cur = cur.superName ? classMap.get(cur.superName) : undefined;
    }
    if (chain.some((i) => FUNCTIONAL_INTERFACES.has(i)) || runnableSubclasses.has(cls.name)) {
      const bodies = cls.methods
        .filter((m) => m.name === "run" || m.name === "call" || m.name === "accept" || m.name === "get" || m.name === "apply")
        .map((m) => key(cls.name, m.name, m.desc));
      if (bodies.length > 0) functionalImpls.set(cls.name, bodies);
    }
  }

  // Bind task bodies to sink calls: the nearest preceding lambda handle or
  // functional-class construction in bytecode order is the scheduled task.
  for (const cls of classes) {
    for (const m of cls.methods) {
      const pending: string[][] = [];
      for (const inv of m.invocations) {
        if (inv.handle) {
          if (classMap.has(inv.owner)) pending.push([key(inv.owner, inv.name, inv.desc)]);
          continue;
        }
        if (inv.name === "<init>" && functionalImpls.has(inv.owner)) {
          pending.push(functionalImpls.get(inv.owner)!);
          // constructors can themselves be sinks (new Thread(r)) — fall through
        }
        const async = seedSinkAsync(inv) ?? jarSinks.get(key(inv.owner, inv.name, inv.desc)) ?? null;
        if (async !== null && pending.length > 0) {
          const targets = pending.pop()!;
          for (const t of targets) {
            if (methodMap.has(t)) addCtx(t, async ? "TASK_ASYNC" : "TASK_SYNC");
          }
        }
      }
    }
  }

  // ---- 2. Propagate contexts through the jar-internal call graph ----
  const worklist: string[] = [...contexts.keys()];
  while (worklist.length > 0) {
    const k = worklist.pop()!;
    const entry = methodMap.get(k);
    if (!entry) continue;
    const ctxs = contexts.get(k)!;
    for (const inv of entry.method.invocations) {
      const targetKey = key(inv.owner, inv.name, inv.desc);
      if (!methodMap.has(targetKey)) continue;
      // Direct calls inherit the caller's contexts. Handles not consumed by a
      // scheduler (forEach, Optional.map, …) also run in the caller's context.
      let changed = false;
      for (const ctx of ctxs) changed = addCtx(targetKey, ctx) || changed;
      if (changed) worklist.push(targetKey);
    }
  }

  // ---- 3. Aggregate field accesses by context ----
  interface Agg {
    contexts: Set<Context>;
    reads: number;
    writes: number;
    /** Writes outside the declaring class's own constructor/static-initializer. */
    mutationWrites: number;
    samples: string[];
  }
  const fields = new Map<string, Agg>();

  for (const [k, ctxs] of contexts) {
    const entry = methodMap.get(k);
    if (!entry) continue;
    const isInitMethod = (fieldOwner: string) =>
      entry.cls.name === fieldOwner && (entry.method.name === "<init>" || entry.method.name === "<clinit>");

    const touch = (fieldOwner: string, fieldName: string, kind: "read" | "write" | "mutate"): Agg | null => {
      const ownerCls = classMap.get(fieldOwner);
      if (!ownerCls) return null;
      const decl = ownerCls.fields.find((f) => f.name === fieldName);
      if (!decl || decl.access & ACC_SYNTHETIC || !decl.desc.startsWith("L")) return null;
      const fk = `${fieldOwner}#${fieldName}`;
      let agg = fields.get(fk);
      if (!agg) fields.set(fk, (agg = { contexts: new Set(), reads: 0, writes: 0, mutationWrites: 0, samples: [] }));
      for (const ctx of ctxs) agg.contexts.add(ctx);
      if (kind === "read") agg.reads++;
      else {
        agg.writes++;
        // Slot writes and content mutations inside the declaring class's own
        // <init>/<clinit> are initialization, not cross-thread mutation.
        if (!isInitMethod(fieldOwner)) agg.mutationWrites++;
      }
      if (agg.samples.length < 6) {
        agg.samples.push(`${entry.cls.name}#${entry.method.name} [${[...ctxs].join(",")}] ${kind}`);
      }
      return agg;
    };

    // Slot-level reads/writes.
    for (const fa of entry.method.fieldAccesses) {
      touch(fa.owner, fa.name, fa.write ? "write" : "read");
    }

    // Content mutations: map.put(...) compiles to GETFIELD + INVOKE — bind the
    // mutating call to the nearest preceding collection-typed field read.
    const collectionReads = entry.method.fieldAccesses.filter(
      (fa) => !fa.write && fa.desc.startsWith("Ljava/util/"),
    );
    if (collectionReads.length > 0) {
      for (const inv of entry.method.invocations) {
        if (inv.handle || !inv.owner.startsWith("java/util/") || !COLLECTION_MUTATORS.has(inv.name)) continue;
        let best: (typeof collectionReads)[number] | null = null;
        for (const fa of collectionReads) {
          if (fa.seq < inv.seq && inv.seq - fa.seq <= MUTATOR_BIND_WINDOW) {
            if (!best || fa.seq > best.seq) best = fa;
          }
        }
        if (best) touch(best.owner, best.name, "mutate");
      }
    }
  }

  // ---- 4. Classify risk ----
  const findings: SharedFieldFinding[] = [];
  for (const [fk, agg] of fields) {
    const [owner, fieldName] = fk.split("#");
    const decl = classMap.get(owner)!.fields.find((f) => f.name === fieldName)!;
    const desc = decl.desc;

    if (CONCURRENT_SAFE_PREFIXES.some((p) => desc.startsWith(p))) continue;

    const selfConcurrent = [...agg.contexts].some((c) => SELF_CONCURRENT.has(c));
    const crossContext = agg.contexts.size >= 2;
    const concurrent = selfConcurrent || crossContext;

    let risk: SharedFieldFinding["risk"];
    if (agg.mutationWrites === 0 || !concurrent) {
      risk = "low"; // read-only, init-only, or never crossing concurrent contexts
    } else if (UNSAFE_CONCRETE.has(desc)) {
      risk = "high";
    } else if (COLLECTION_INTERFACES.has(desc)) {
      risk = "medium";
    } else {
      risk = "medium";
    }

    const suggestion =
      risk === "high" || COLLECTION_INTERFACES.has(desc)
        ? "Tier 2: swap to a concurrent collection; Tier 3 if compound check-then-act logic exists"
        : "Review: mutable object crossing thread contexts — Tier 3 candidate";

    findings.push({
      owner,
      field: fieldName,
      desc,
      isStatic: (decl.access & ACC_STATIC) !== 0,
      isVolatile: (decl.access & ACC_VOLATILE) !== 0,
      contexts: [...agg.contexts],
      reads: agg.reads,
      writes: agg.writes,
      risk,
      sampleSites: agg.samples,
      suggestion,
    });
  }

  const riskOrder = { high: 0, medium: 1, low: 2 };
  findings.sort(
    (a, b) =>
      riskOrder[a.risk] - riskOrder[b.risk] || Number(b.isStatic) - Number(a.isStatic) || b.writes - a.writes,
  );

  // ---- 5. Region-lock violations: region-locked API calls in methods
  // reachable from an off-region context (async / global scheduler / command).
  const region = loadRegionCatalog();
  const regionViolations: RegionViolation[] = [];
  if (region.loaded) {
    const seen = new Set<string>();
    for (const [k, ctxs] of contexts) {
      const off = [...ctxs].filter((c) => OFF_REGION.has(c));
      if (off.length === 0) continue;
      const entry = methodMap.get(k);
      if (!entry) continue;
      const isAsync = off.includes("TASK_ASYNC");
      for (const inv of entry.method.invocations) {
        if (inv.handle) continue;
        if (!region.isGuarded(inv.owner, inv.name, inv.desc)) continue;
        const dedup = `${entry.cls.name}#${entry.method.name}#${inv.owner}.${inv.name}${inv.desc}`;
        if (seen.has(dedup)) continue;
        seen.add(dedup);
        regionViolations.push({
          className: entry.cls.name,
          method: `${entry.method.name}${entry.method.desc}`,
          call: { owner: inv.owner, name: inv.name, desc: inv.desc },
          contexts: off,
          async: isAsync,
          mutation: !isReadCall(inv.name, inv.desc),
        });
      }
    }
    // Mutations first (definite crashes), then async before global-scheduler.
    regionViolations.sort(
      (a, b) => Number(b.mutation) - Number(a.mutation) || Number(b.async) - Number(a.async),
    );
  }

  return { jar: index.jar, methodsWithContext: contexts.size, findings, regionViolations };
}
