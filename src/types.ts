/** Output of the engine's `index` command (see engine/…/Indexer.java). */
export interface EngineIndex {
  jar: string;
  pluginYml: string | null;
  classes: IndexedClass[];
  warnings: string[];
}

export interface IndexedClass {
  name: string;
  superName: string | null;
  interfaces: string[];
  access: number;
  fields: IndexedField[];
  methods: IndexedMethod[];
}

export interface IndexedField {
  name: string;
  desc: string;
  access: number;
}

export interface IndexedMethod {
  name: string;
  desc: string;
  access: number;
  annotations: string[];
  invocations: Invocation[];
  fieldAccesses: FieldAccess[];
}

/** One call site: `owner.name(desc)` in JVM internal notation. */
export interface Invocation {
  owner: string;
  name: string;
  desc: string;
  itf: boolean;
  /** True for method-reference/lambda targets recorded from invokedynamic. */
  handle: boolean;
  /** Bytecode-order index within the method, shared with fieldAccesses. */
  seq: number;
}

export interface FieldAccess {
  owner: string;
  name: string;
  desc: string;
  write: boolean;
  /** Bytecode-order index within the method, shared with invocations. */
  seq: number;
}

export type Severity = "blocker" | "warning" | "review";

/** One region-locked Bukkit API method mined from the Folia server jar. */
export interface RegionGuardedMethod {
  prefix: string;
  name: string;
  desc: string;
}

export interface RegionCatalog {
  version: number;
  generatedFrom: string;
  generatedAt: string;
  methods: RegionGuardedMethod[];
}

/** A region-locked API call reachable from a thread that won't own the region. */
export interface RegionViolation {
  className: string;
  method: string;
  call: { owner: string; name: string; desc: string };
  contexts: string[];
  /** true = definitely off-region (async); false = global-scheduler (throws for entity/block ops). */
  async: boolean;
  /** true = state mutation (definite crash off-region); false = read (lower risk). */
  mutation: boolean;
}

/** Engine `minefolia` result. */
export interface MineResult {
  jars: string[];
  classesScanned: number;
  directGuardCallers: number;
  craftMethodsReached: number;
  maxDepth: number;
  api: { ownerPrefix: string; name: string; desc: string; via: string }[];
  warnings: string[];
}

export interface RuleMatch {
  /** JVM internal names, e.g. "org/bukkit/scheduler/BukkitScheduler". */
  owners?: string[];
  /** Match any call-site owner under this internal-name prefix, e.g. "org/bukkit/entity/". */
  ownerPrefix?: string;
  names?: string[];
  descContains?: string;
}

export interface Rule {
  id: string;
  severity: Severity;
  title: string;
  detail: string;
  match: RuleMatch;
  /**
   * Also match invocations whose owner is a class in the scanned jar that
   * (transitively) extends this type — catches e.g. `MyTask extends
   * BukkitRunnable` call sites, whose owner is MyTask, not BukkitRunnable.
   */
  extendOwnersWithSubclassesOf?: string;
}

export interface Catalog {
  version: number;
  rules: Rule[];
}

export interface Finding {
  ruleId: string;
  severity: Severity;
  title: string;
  className: string;
  method: string;
  invocation: Invocation;
}

export interface PluginMeta {
  name?: string;
  version?: string;
  main?: string;
  apiVersion?: string;
  foliaSupported: boolean;
  depend?: string[];
  softDepend?: string[];
}

export interface ScanResult {
  jar: string;
  plugin: PluginMeta | null;
  findings: Finding[];
  classCount: number;
  methodCount: number;
  invocationCount: number;
  engineWarnings: string[];
}

/** One rewrite rule sent to the engine (matches Transform.Redirect in Java). */
export interface RedirectSpec {
  id: string;
  owners: string[] | null;
  ownerPrefix: string | null;
  name: string;
  desc: string;
  targetOwner: string;
  targetName: string;
  targetDesc: string;
  /** True for static-call redirects (INVOKESTATIC Bukkit.foo → ShimStatic.foo). */
  staticCall: boolean;
}

/** Tier 2 fix candidate sent to the engine (matches Transform.CollectionFix). */
export interface CollectionFixSpec {
  fieldOwner: string;
  fieldName: string;
}

/** Engine `transform` job (matches Transform.Job in Java). */
export interface TransformJob {
  inputJar: string;
  outputJar: string;
  redirects: RedirectSpec[];
  injectJar: string | null;
  relocation: { fromPrefix: string; toPrefix: string };
  setFoliaSupported: boolean;
  collectionFixes: CollectionFixSpec[];
  /** Written into the jar as folia-on-demand.properties (audit trail). */
  stamp: Record<string, string> | null;
}

/** One applied Tier 2 fix (matches Transform.AppliedFix in Java). */
export interface AppliedFix {
  field: string;
  strategy: string;
  sites: number;
  unmatchedWrites: number;
}

/** Engine `transform` result (matches Transform.Result in Java). */
export interface TransformResult {
  classesScanned: number;
  classesModified: number;
  rewrites: Record<string, number>;
  injectedClasses: number;
  pluginYmlPatched: boolean;
  strippedEntries: string[];
  concurrencyFixes: AppliedFix[];
  warnings: string[];
  /** Internal names of plugin classes whose bytecode was rewritten. */
  modifiedClasses: string[];
}

/** A high-risk field Tier 2 could not fix mechanically — Tier 3's work queue. */
export interface Tier3Target {
  owner: string;
  field: string;
  desc: string;
}

export interface ConvertOutcome {
  jarPath: string;
  outputJar: string;
  targetPrefix: string;
  preScan: ScanResult;
  postScan: ScanResult;
  result: TransformResult;
  skippedShimMethods: string[];
  /** High-risk concrete-typed fields the fixer cannot touch safely (Tier 3). */
  tier3Targets: Tier3Target[];
  /** Region-locked mutations reachable from off-region contexts (not auto-fixed). */
  regionViolations: RegionViolation[];
}
