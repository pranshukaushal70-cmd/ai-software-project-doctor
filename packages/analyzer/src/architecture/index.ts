import { readFile } from "node:fs/promises";
import type { Severity } from "@pd/shared/constants";
import { fingerprint, type CodeFinding } from "../metrics";
import type { ScannedFile } from "../scanner";
import { severityRank } from "../security/types";
import { ANALYZER_VERSION } from "../version";
import { shortestCycle, stronglyConnectedComponents } from "./graph";
import { createResolver, type Resolver } from "./resolve";
import { ARCHITECTURE_RULES, ARCHITECTURE_THRESHOLDS, inferLayer, LAYERS, layerLabel, layerRank, type ArchitectureRuleKey, type LayerId } from "./rules";

export const ARCHITECTURE_ANALYZER_ID = "architecture";

export interface ArchitectureFinding extends Omit<CodeFinding, "category" | "line" | "endLine"> {
  category: "ARCHITECTURE";
  line: number | null;
  endLine: number | null;
}

export interface ArchitectureNodeRecord {
  /** `file:<path>` or `module:<dir>`. */
  key: string;
  kind: "FILE" | "MODULE";
  label: string;
  layer: LayerId | null;
  metrics: Record<string, number | boolean | string>;
}

export interface ArchitectureEdgeRecord {
  from: string;
  to: string;
  /** `import` between files, `module` between modules (aggregated file imports). */
  kind: "import" | "module";
  weight: number;
  inCycle: boolean;
}

export interface ArchitectureSummary {
  analyzer: string;
  analyzerVersion: string;
  thresholds: typeof ARCHITECTURE_THRESHOLDS;
  totals: {
    /** Production source files in the graph. */
    files: number;
    /** Distinct file → file import edges. */
    edges: number;
    internalImports: number;
    externalImports: number;
    builtinImports: number;
    /** Relative or local-looking imports that match no file. */
    unresolvedImports: number;
    cycles: number;
    filesInCycles: number;
    modules: number;
    moduleEdges: number;
    layerViolations: number;
    /** Files with no internal imports in either direction. */
    isolatedFiles: number;
    maxFanIn: number;
    maxFanOut: number;
    avgFanOut: number;
  };
  byLanguage: Array<{ language: string; files: number; edges: number; unresolved: number }>;
  /** Directory depth used for the module view. */
  moduleDepth: number;
  modules: Array<{
    key: string;
    label: string;
    files: number;
    loc: number;
    /** Modules that depend on this one. */
    fanIn: number;
    /** Modules this one depends on. */
    fanOut: number;
    /** fanOut / (fanIn + fanOut): 0 = stable (depended upon), 1 = unstable (only depends on others). */
    instability: number;
    layer: LayerId | null;
    inCycle: boolean;
  }>;
  moduleEdges: Array<{ from: string; to: string; weight: number; inCycle: boolean }>;
  cycles: Array<{ files: string[]; size: number; path: string[]; severity: Severity }>;
  /** Most depended-upon files. */
  hubs: Array<{ path: string; fanIn: number; fanOut: number }>;
  /** Files importing the most other files. */
  mostDependent: Array<{ path: string; fanIn: number; fanOut: number }>;
  layers: {
    /** Layer analysis runs only when at least two layers are present. */
    applied: boolean;
    order: Array<{ id: LayerId; label: string; files: number }>;
    violations: number;
  };
  topExternal: Array<{ name: string; language: string; files: number }>;
  resolution: { tsconfigs: number; pathAliases: number; workspacePackages: number; pythonRoots: string[] };
  nodes: { total: number; stored: number; truncated: boolean };
  findings: { total: number; stored: number; truncated: boolean; bySeverity: Record<Severity, number>; byType: Record<string, number> };
  durationMs: number;
}

export interface ArchitectureAnalysis {
  nodes: ArchitectureNodeRecord[];
  edges: ArchitectureEdgeRecord[];
  findings: ArchitectureFinding[];
  summary: ArchitectureSummary;
}

export interface ArchitectureInputFile {
  path: string;
  language: string;
  imports: readonly string[];
  codeLines: number;
}

export interface AnalyzeArchitectureOptions {
  maxFindings?: number;
  maxFileNodes?: number;
}

const SEVERITIES: Severity[] = ["CRITICAL", "HIGH", "MEDIUM", "LOW", "INFO"];
const RUNTIME_CYCLE_LANGUAGES = new Set(["javascript", "typescript", "python"]);
const BARREL = /(^|\/)(index\.[cm]?[jt]sx?|__init__\.py|mod\.rs)$/;
const round2 = (n: number) => Math.round(n * 100) / 100;
const up = (s: Severity): Severity => SEVERITIES[Math.max(0, SEVERITIES.indexOf(s) - 1)]!;

const dirOf = (p: string) => (p.includes("/") ? p.slice(0, p.lastIndexOf("/")) : "");
const moduleOf = (path: string, depth: number) => {
  const segs = dirOf(path).split("/").filter(Boolean);
  return segs.length === 0 ? "." : segs.slice(0, depth).join("/");
};

/** Deepest directory level (≤ 8) whose module count stays within the limit; ties prefer the shallower level. */
function chooseModuleDepth(paths: readonly string[], max: number): number {
  let best = 1;
  let bestCount = -1;
  for (let d = 1; d <= 8; d++) {
    const count = new Set(paths.map((p) => moduleOf(p, d))).size;
    if (count <= max && count > bestCount) {
      best = d;
      bestCount = count;
    }
  }
  return best;
}

/** Shortest labels that stay unique: modules share a long common prefix in most repositories. */
function moduleLabels(keys: readonly string[]): Map<string, string> {
  const real = keys.filter((k) => k !== ".");
  let prefix = real.length > 1 ? real[0]!.split("/") : [];
  for (const k of real) {
    const segs = k.split("/");
    let i = 0;
    while (i < prefix.length && i < segs.length - 1 && prefix[i] === segs[i]) i++;
    prefix = prefix.slice(0, i);
  }
  const strip = prefix.length ? `${prefix.join("/")}/` : "";
  return new Map(keys.map((k) => [k, k === "." ? "(root)" : k.startsWith(strip) ? k.slice(strip.length) : k]));
}

/**
 * Builds the internal import graph of production source files, finds import
 * cycles (strongly connected components), aggregates a module view by
 * directory, and checks conventional layering and coupling.
 */
export async function analyzeArchitecture(
  scanFiles: readonly Pick<ScannedFile, "path" | "absPath" | "size" | "kind">[],
  codeFiles: readonly ArchitectureInputFile[],
  kinds: ReadonlyMap<string, ScannedFile["kind"]>,
  opts: AnalyzeArchitectureOptions = {},
): Promise<ArchitectureAnalysis> {
  const started = performance.now();
  const byPath = new Map(scanFiles.map((f) => [f.path, f]));
  const resolver: Resolver = await createResolver({
    paths: scanFiles.map((f) => f.path),
    async read(rel) {
      const f = byPath.get(rel);
      if (!f || f.size > 512 * 1024) return null;
      try {
        return await readFile(f.absPath, "utf8");
      } catch {
        return null;
      }
    },
  });

  // ---------------------------------------------------------------- file graph
  const nodes = codeFiles.filter((f) => kinds.get(f.path) === "SOURCE").sort((a, b) => a.path.localeCompare(b.path));
  const indexOf = new Map(nodes.map((f, i) => [f.path, i]));
  const weights: Array<Map<number, number>> = nodes.map(() => new Map());
  const counts = { internal: 0, external: 0, builtin: 0, unresolved: 0 };
  const langStats = new Map<string, { files: number; edges: number; unresolved: number }>();
  const external = new Map<string, { language: string; files: Set<string> }>();

  nodes.forEach((f, i) => {
    const stat = langStats.get(f.language) ?? { files: 0, edges: 0, unresolved: 0 };
    stat.files++;
    langStats.set(f.language, stat);
    for (const spec of f.imports) {
      const r = resolver.resolve(f.path, f.language, spec);
      if (r.kind === "internal") {
        counts.internal++;
        for (const target of r.targets) {
          const j = indexOf.get(target);
          // Imports of tests, assets or generated files are not part of the production graph.
          if (j === undefined || j === i) continue;
          weights[i]!.set(j, (weights[i]!.get(j) ?? 0) + 1);
        }
      } else if (r.kind === "external") {
        counts.external++;
        const key = `${f.language}\0${r.name}`;
        const e = external.get(key) ?? { language: f.language, files: new Set() };
        e.files.add(f.path);
        external.set(key, e);
      } else if (r.kind === "builtin") counts.builtin++;
      else {
        counts.unresolved++;
        stat.unresolved++;
      }
    }
    stat.edges += weights[i]!.size;
  });

  const adjacency = weights.map((w) => [...w.keys()].sort((a, b) => a - b));
  const fanIn = new Array<number>(nodes.length).fill(0);
  for (const targets of adjacency) for (const j of targets) fanIn[j]!++;
  const fanOut = adjacency.map((a) => a.length);

  // ---------------------------------------------------------------- cycles
  const raw: Array<{ rule: ArchitectureRuleKey; path: string; severity: Severity; evidence: string; key: string; data?: Record<string, unknown> }> = [];
  const components = stronglyConnectedComponents(adjacency).filter((c) => c.length > 1);
  const componentOf = new Array<number>(nodes.length).fill(-1);
  components.forEach((c, ci) => c.forEach((v) => (componentOf[v] = ci)));
  const cycles: ArchitectureSummary["cycles"] = [];
  for (const component of components) {
    const members = [...component].sort((a, b) => a - b);
    const start = members[0]!;
    const cyclePath = (shortestCycle(adjacency, start, new Set(members)) ?? [start, start]).map((v) => nodes[v]!.path);
    const files = members.map((v) => nodes[v]!.path);
    const runtime = members.some((v) => RUNTIME_CYCLE_LANGUAGES.has(nodes[v]!.language));
    let severity: Severity = runtime ? "MEDIUM" : "LOW";
    if (members.length >= ARCHITECTURE_THRESHOLDS.largeCycleFiles) severity = up(severity);
    const others = members.length - (cyclePath.length - 1);
    raw.push({
      rule: "cycle",
      path: files[0]!,
      severity,
      evidence:
        `${cyclePath.map((p) => `\`${p}\``).join(" → ")}` +
        (others > 0 ? `; ${others} more ${others === 1 ? "file is" : "files are"} part of the same cycle (${members.length} files in total).` : ".") +
        (runtime ? "" : " Compiled languages tolerate import cycles, so this is a design issue rather than a runtime risk."),
      key: files.join("\n"),
      data: { files: files.slice(0, 50), size: members.length, path: cyclePath },
    });
    cycles.push({ files: files.slice(0, 50), size: members.length, path: cyclePath, severity });
  }
  cycles.sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || b.size - a.size);

  // ---------------------------------------------------------------- layers
  const layers = nodes.map((f) => inferLayer(f.path));
  const layerCounts = new Map<LayerId, number>();
  for (const l of layers) if (l) layerCounts.set(l, (layerCounts.get(l) ?? 0) + 1);
  const layersApplied = layerCounts.size >= 2;
  let layerViolations = 0;
  if (layersApplied) {
    adjacency.forEach((targets, i) => {
      const from = layers[i];
      if (!from) return;
      for (const j of targets) {
        const to = layers[j];
        if (!to || layerRank(from) <= layerRank(to)) continue;
        layerViolations++;
        raw.push({
          rule: "layerViolation",
          path: nodes[i]!.path,
          severity: "LOW",
          evidence: `\`${nodes[i]!.path}\` (${layerLabel(from)}) imports \`${nodes[j]!.path}\` (${layerLabel(to)}). Layers are inferred from directory and file names; the expected direction is ${LAYERS.map((l) => l.label).join(" → ")}.`,
          key: nodes[j]!.path,
          data: { fromLayer: from, toLayer: to, target: nodes[j]!.path },
        });
      }
    });
  }

  // ---------------------------------------------------------------- coupling
  nodes.forEach((f, i) => {
    const n = fanOut[i]!;
    if (n <= ARCHITECTURE_THRESHOLDS.fanOut.low || BARREL.test(f.path)) return;
    const severity: Severity = n > ARCHITECTURE_THRESHOLDS.fanOut.medium ? "MEDIUM" : "LOW";
    raw.push({
      rule: "highFanOut",
      path: f.path,
      severity,
      evidence: `\`${f.path}\` imports ${n} other files of this repository (limit ${ARCHITECTURE_THRESHOLDS.fanOut.low}); ${fanIn[i]} files import it.`,
      key: "fan-out",
      data: { value: n, limit: ARCHITECTURE_THRESHOLDS.fanOut.low, fanIn: fanIn[i] },
    });
  });

  // ---------------------------------------------------------------- modules
  const depth = chooseModuleDepth(nodes.map((f) => f.path), ARCHITECTURE_THRESHOLDS.maxModules);
  const moduleKeys = nodes.map((f) => moduleOf(f.path, depth));
  const uniqueModules = [...new Set(moduleKeys)].sort();
  const labels = moduleLabels(uniqueModules);
  const mIndex = new Map(uniqueModules.map((m, i) => [m, i]));
  const mWeights: Array<Map<number, number>> = uniqueModules.map(() => new Map());
  adjacency.forEach((targets, i) => {
    const a = mIndex.get(moduleKeys[i]!)!;
    for (const j of targets) {
      const b = mIndex.get(moduleKeys[j]!)!;
      if (a !== b) mWeights[a]!.set(b, (mWeights[a]!.get(b) ?? 0) + weights[i]!.get(j)!);
    }
  });
  const mAdj = mWeights.map((w) => [...w.keys()]);
  const mComponent = new Array<number>(uniqueModules.length).fill(-1);
  stronglyConnectedComponents(mAdj)
    .filter((c) => c.length > 1)
    .forEach((c, ci) => c.forEach((v) => (mComponent[v] = ci)));
  const mFanIn = new Array<number>(uniqueModules.length).fill(0);
  for (const t of mAdj) for (const b of t) mFanIn[b]!++;
  const modules: ArchitectureSummary["modules"] = uniqueModules.map((key, m) => {
    const members = nodes.filter((_, i) => moduleKeys[i] === key);
    const memberLayers = new Map<LayerId, number>();
    nodes.forEach((_, i) => {
      if (moduleKeys[i] === key && layers[i]) memberLayers.set(layers[i]!, (memberLayers.get(layers[i]!) ?? 0) + 1);
    });
    const dominant = [...memberLayers.entries()].sort((a, b) => b[1] - a[1])[0];
    const out = mAdj[m]!.length;
    const inn = mFanIn[m]!;
    return {
      key,
      label: labels.get(key)!,
      files: members.length,
      loc: members.reduce((n, f) => n + f.codeLines, 0),
      fanIn: inn,
      fanOut: out,
      instability: inn + out ? round2(out / (inn + out)) : 0,
      layer: dominant && dominant[1] * 2 > members.length ? dominant[0] : null,
      inCycle: mComponent[m] !== -1,
    };
  });
  const moduleEdges = mWeights
    .flatMap((w, a) => [...w.entries()].map(([b, weight]) => ({ from: uniqueModules[a]!, to: uniqueModules[b]!, weight, inCycle: mComponent[a] !== -1 && mComponent[a] === mComponent[b] })))
    .sort((x, y) => y.weight - x.weight || x.from.localeCompare(y.from) || x.to.localeCompare(y.to));

  // ---------------------------------------------------------------- records
  const maxNodes = opts.maxFileNodes ?? 10_000;
  const kept = nodes
    .map((_, i) => i)
    .sort((a, b) => fanIn[b]! + fanOut[b]! - (fanIn[a]! + fanOut[a]!) || a - b)
    .slice(0, maxNodes);
  const keptSet = new Set(kept);
  const nodeRecords: ArchitectureNodeRecord[] = [
    ...kept.sort((a, b) => a - b).map((i) => ({
      key: `file:${nodes[i]!.path}`,
      kind: "FILE" as const,
      label: nodes[i]!.path,
      layer: layers[i] ?? null,
      metrics: { fanIn: fanIn[i]!, fanOut: fanOut[i]!, loc: nodes[i]!.codeLines, module: moduleKeys[i]!, inCycle: componentOf[i] !== -1, language: nodes[i]!.language },
    })),
    ...modules.map((m) => ({
      key: `module:${m.key}`,
      kind: "MODULE" as const,
      label: m.label,
      layer: m.layer,
      metrics: { files: m.files, loc: m.loc, fanIn: m.fanIn, fanOut: m.fanOut, instability: m.instability, inCycle: m.inCycle },
    })),
  ];
  const edgeRecords: ArchitectureEdgeRecord[] = [
    ...adjacency.flatMap((targets, i) =>
      keptSet.has(i)
        ? targets
            .filter((j) => keptSet.has(j))
            .map((j) => ({
              from: `file:${nodes[i]!.path}`,
              to: `file:${nodes[j]!.path}`,
              kind: "import" as const,
              weight: weights[i]!.get(j)!,
              inCycle: componentOf[i] !== -1 && componentOf[i] === componentOf[j],
            }))
        : [],
    ),
    ...moduleEdges.map((e) => ({ from: `module:${e.from}`, to: `module:${e.to}`, kind: "module" as const, weight: e.weight, inCycle: e.inCycle })),
  ];

  // ---------------------------------------------------------------- findings
  const ordinals = new Map<string, number>();
  const all: ArchitectureFinding[] = raw.map((f) => {
    const rule = ARCHITECTURE_RULES[f.rule];
    const base = `${rule.id}\0${f.path}\0${f.key}`;
    const ordinal = ordinals.get(base) ?? 0;
    ordinals.set(base, ordinal + 1);
    return {
      ruleId: rule.id,
      type: rule.type,
      category: "ARCHITECTURE",
      severity: f.severity,
      title: rule.title,
      path: f.path,
      line: null,
      endLine: null,
      evidence: f.evidence,
      impact: rule.impact,
      recommendation: rule.recommendation,
      fingerprint: fingerprint(rule.id, f.path, ordinal === 0 ? f.key : `${f.key}#${ordinal}`),
      analyzer: ARCHITECTURE_ANALYZER_ID,
      analyzerVersion: ANALYZER_VERSION,
      data: f.data ?? null,
    };
  });
  const bySeverity = Object.fromEntries(SEVERITIES.map((s) => [s, 0])) as Record<Severity, number>;
  const byType: Record<string, number> = {};
  for (const f of all) {
    bySeverity[f.severity]++;
    byType[f.type] = (byType[f.type] ?? 0) + 1;
  }
  const maxFindings = opts.maxFindings ?? 2000;
  const stored = [...all].sort((a, b) => severityRank(a.severity) - severityRank(b.severity) || a.path.localeCompare(b.path)).slice(0, maxFindings);

  const fileStat = (i: number) => ({ path: nodes[i]!.path, fanIn: fanIn[i]!, fanOut: fanOut[i]! });
  const indices = nodes.map((_, i) => i);
  const edgeCount = adjacency.reduce((n, a) => n + a.length, 0);

  return {
    nodes: nodeRecords,
    edges: edgeRecords,
    findings: stored,
    summary: {
      analyzer: ARCHITECTURE_ANALYZER_ID,
      analyzerVersion: ANALYZER_VERSION,
      thresholds: ARCHITECTURE_THRESHOLDS,
      totals: {
        files: nodes.length,
        edges: edgeCount,
        internalImports: counts.internal,
        externalImports: counts.external,
        builtinImports: counts.builtin,
        unresolvedImports: counts.unresolved,
        cycles: components.length,
        filesInCycles: components.reduce((n, c) => n + c.length, 0),
        modules: uniqueModules.length,
        moduleEdges: moduleEdges.length,
        layerViolations,
        isolatedFiles: indices.filter((i) => fanIn[i] === 0 && fanOut[i] === 0).length,
        maxFanIn: fanIn.reduce((m, v) => Math.max(m, v), 0),
        maxFanOut: fanOut.reduce((m, v) => Math.max(m, v), 0),
        avgFanOut: nodes.length ? round2(edgeCount / nodes.length) : 0,
      },
      byLanguage: [...langStats.entries()].map(([language, s]) => ({ language, ...s })).sort((a, b) => b.files - a.files),
      moduleDepth: depth,
      modules: [...modules].sort((a, b) => b.files - a.files || a.key.localeCompare(b.key)).slice(0, 60),
      moduleEdges: moduleEdges.slice(0, 300),
      cycles: cycles.slice(0, 50),
      hubs: indices
        .filter((i) => fanIn[i]! > 0)
        .sort((a, b) => fanIn[b]! - fanIn[a]! || a - b)
        .slice(0, 10)
        .map(fileStat),
      mostDependent: indices
        .filter((i) => fanOut[i]! > 0)
        .sort((a, b) => fanOut[b]! - fanOut[a]! || a - b)
        .slice(0, 10)
        .map(fileStat),
      layers: {
        applied: layersApplied,
        order: LAYERS.map((l) => ({ id: l.id, label: l.label, files: layerCounts.get(l.id) ?? 0 })),
        violations: layerViolations,
      },
      topExternal: [...external.entries()]
        .map(([key, e]) => ({ name: key.split("\0")[1]!, language: e.language, files: e.files.size }))
        .sort((a, b) => b.files - a.files || a.name.localeCompare(b.name))
        .slice(0, 15),
      resolution: resolver.info,
      nodes: { total: nodes.length, stored: kept.length, truncated: nodes.length > kept.length },
      findings: { total: all.length, stored: stored.length, truncated: all.length > stored.length, bySeverity, byType },
      durationMs: Math.round(performance.now() - started),
    },
  };
}

export { ARCHITECTURE_RULES, ARCHITECTURE_THRESHOLDS, LAYERS, inferLayer } from "./rules";
export { createResolver, stripJsonc, type Resolution } from "./resolve";
export { stronglyConnectedComponents, shortestCycle } from "./graph";
