/**
 * The landing page's hero illustration: a small, fixed repository graph around an "AI core",
 * placed in 3D and projected with perspective. Pure and deterministic (no DOM), so the canvas
 * scene, the static SVG fallback and the tests all use the same geometry.
 *
 * It is an illustration of the workflow, not data: no repository is read, and nothing here is
 * a real finding, score or test result.
 */

export type NodeKind = "core" | "module" | "source" | "test" | "package" | "config";

export interface SceneNode {
  id: string;
  /** What the hover label shows, e.g. `src/api/routes.ts`. */
  label: string;
  kind: NodeKind;
  x: number;
  y: number;
  z: number;
}

export interface SceneEdge {
  from: string;
  to: string;
  /** 0–1, staggers the pulses that travel along the edge. */
  offset: number;
}

export interface SceneParticle {
  x: number;
  y: number;
  z: number;
  phase: number;
}

export interface SceneFragment {
  text: string;
  x: number;
  y: number;
  z: number;
}

export interface Scene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  particles: SceneParticle[];
  fragments: SceneFragment[];
  /** Nodes that the illustration marks in its "findings", "plan" and "review" steps. */
  marked: { findings: string[]; plan: string[]; review: string[] };
}

export interface View {
  yaw: number;
  pitch: number;
  width: number;
  height: number;
}

export interface Projected {
  x: number;
  y: number;
  /** Perspective factor: > 1 in front of the core, < 1 behind it. */
  k: number;
  /** Depth after rotation; larger is nearer to the viewer. */
  z: number;
}

/** The workflow the scene walks through, one step every PHASE_MS. */
export const PHASES = ["Index the repository", "Map dependencies", "Surface findings", "Plan the change", "Review safely"] as const;
export const PHASE_MS = 3200;

export const KIND_LABEL: Record<NodeKind, string> = {
  core: "AI core",
  module: "module",
  source: "source file",
  test: "test file",
  package: "package",
  config: "configuration",
};

const MODULES: Array<{ id: string; label: string; children: Array<[string, NodeKind]> }> = [
  { id: "api", label: "src/api", children: [["src/api/routes.ts", "source"], ["src/api/handlers.ts", "source"]] },
  { id: "auth", label: "src/auth", children: [["src/auth/session.ts", "source"], ["src/auth/tokens.ts", "source"]] },
  { id: "db", label: "src/db", children: [["src/db/client.ts", "source"], ["prisma/schema.prisma", "config"]] },
  { id: "ui", label: "src/ui", children: [["src/ui/App.tsx", "source"], ["src/ui/Dashboard.tsx", "source"]] },
  { id: "lib", label: "src/lib", children: [["src/lib/utils.ts", "source"], ["src/lib/logger.ts", "source"]] },
  { id: "tests", label: "tests", children: [["tests/api.test.ts", "test"], ["tests/auth.test.ts", "test"]] },
  { id: "deps", label: "package.json", children: [["express", "package"], ["zod", "package"]] },
  { id: "config", label: "config", children: [["tsconfig.json", "config"], ["Dockerfile", "config"]] },
];

/** Imports between files of different modules: what "dependency analysis" draws. */
const CROSS_EDGES: Array<[string, string]> = [
  ["src/api/routes.ts", "src/auth/session.ts"],
  ["src/api/routes.ts", "src/db/client.ts"],
  ["src/api/handlers.ts", "src/lib/utils.ts"],
  ["src/auth/session.ts", "src/auth/tokens.ts"],
  ["src/db/client.ts", "src/lib/logger.ts"],
  ["src/ui/Dashboard.tsx", "src/api/routes.ts"],
  ["src/ui/App.tsx", "src/ui/Dashboard.tsx"],
  ["tests/api.test.ts", "src/api/routes.ts"],
  ["tests/auth.test.ts", "src/auth/session.ts"],
  ["src/api/routes.ts", "express"],
  ["src/api/handlers.ts", "zod"],
];

const FRAGMENTS = ["import { session } from", "export async function plan()", "await index(repository)", "graph.resolve(imports)", "if (!approved) return", "diff --git a/ b/"];

/** Small deterministic PRNG (mulberry32), so the scene is identical on server and client. */
export function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function buildScene({ seed = 7, particles = 70 }: { seed?: number; particles?: number } = {}): Scene {
  const rand = prng(seed);
  const nodes: SceneNode[] = [{ id: "core", label: "AI core: plans from the repository index", kind: "core", x: 0, y: 0, z: 0 }];
  const edges: SceneEdge[] = [];
  MODULES.forEach((m, i) => {
    const angle = (i / MODULES.length) * Math.PI * 2;
    const y = Math.sin(angle * 2) * 0.55;
    nodes.push({ id: m.id, label: m.label, kind: "module", x: Math.cos(angle) * 1.2, y, z: Math.sin(angle) * 1.2 });
    edges.push({ from: "core", to: m.id, offset: rand() });
    m.children.forEach(([label, kind], j) => {
      const a = angle + (j === 0 ? -0.24 : 0.24);
      const r = 2 + (j === 0 ? 0.05 : -0.05);
      nodes.push({ id: label, label, kind, x: Math.cos(a) * r, y: y + (j === 0 ? 0.72 : -0.62), z: Math.sin(a) * r });
      edges.push({ from: m.id, to: label, offset: rand() });
    });
  });
  for (const [from, to] of CROSS_EDGES) edges.push({ from, to, offset: rand() });

  const dots: SceneParticle[] = [];
  for (let i = 0; i < particles; i++) {
    // Uniform directions on a sphere, at a radius between the rings and beyond.
    const u = rand() * 2 - 1;
    const t = rand() * Math.PI * 2;
    const r = 0.7 + rand() * 2.1;
    const s = Math.sqrt(1 - u * u);
    dots.push({ x: s * Math.cos(t) * r, y: u * r * 0.9, z: s * Math.sin(t) * r, phase: rand() * Math.PI * 2 });
  }
  const fragments = FRAGMENTS.map((text, i) => {
    const a = (i / FRAGMENTS.length) * Math.PI * 2 + 0.4;
    return { text, x: Math.cos(a) * 2.7, y: (rand() - 0.5) * 1.6, z: Math.sin(a) * 2.7 };
  });

  return {
    nodes,
    edges,
    particles: dots,
    fragments,
    marked: {
      findings: ["src/auth/session.ts", "src/db/client.ts"],
      plan: ["core", "api", "src/api/routes.ts", "tests", "tests/api.test.ts"],
      review: ["src/api/routes.ts"],
    },
  };
}

/** Rotates a point around the vertical axis (yaw), then the horizontal axis (pitch). */
export function rotate(p: { x: number; y: number; z: number }, yaw: number, pitch: number) {
  const cy = Math.cos(yaw);
  const sy = Math.sin(yaw);
  const x = p.x * cy + p.z * sy;
  const z1 = -p.x * sy + p.z * cy;
  const cp = Math.cos(pitch);
  const sp = Math.sin(pitch);
  return { x, y: p.y * cp - z1 * sp, z: p.y * sp + z1 * cp };
}

const CAMERA = 6;

/** The resting camera, shared by the canvas and the static poster: slightly from above, so the rings read as depth. */
export const DEFAULT_VIEW = { yaw: 0.6, pitch: -0.42 } as const;

/**
 * Perspective projection into the view; the core sits at the centre. The scale follows the
 * width, limited by the height: the graph is wider than tall, so it also fills a 4:3 frame.
 */
export function project(p: { x: number; y: number; z: number }, view: View): Projected {
  const r = rotate(p, view.yaw, view.pitch);
  const k = CAMERA / (CAMERA - r.z);
  const scale = Math.min(view.width, view.height * 1.3) * 0.19;
  return { x: view.width / 2 + r.x * scale * k, y: view.height / 2 - r.y * scale * k, k, z: r.z };
}

/** Drawn radius of a node at perspective factor k. */
export function nodeRadius(kind: NodeKind, k: number): number {
  const base = kind === "core" ? 16 : kind === "module" ? 5.5 : 3.6;
  return base * k;
}

/** The node under (px, py), preferring the nearest to the viewer; null if none. */
export function hitTest(scene: Scene, view: View, px: number, py: number, slop = 7): SceneNode | null {
  let best: SceneNode | null = null;
  let bestZ = -Infinity;
  for (const n of scene.nodes) {
    const p = project(n, view);
    const r = nodeRadius(n.kind, p.k) + slop;
    if ((p.x - px) ** 2 + (p.y - py) ** 2 <= r * r && p.z > bestZ) {
      best = n;
      bestZ = p.z;
    }
  }
  return best;
}

/** Ids of the nodes directly connected to `id`. */
export function neighbors(scene: Scene, id: string): Set<string> {
  const out = new Set<string>();
  for (const e of scene.edges) {
    if (e.from === id) out.add(e.to);
    if (e.to === id) out.add(e.from);
  }
  return out;
}

/** The node the arrow keys move to: the core first, then every module followed by its files. */
export function stepNode(scene: Scene, current: string | null, direction: 1 | -1): string {
  const ids = scene.nodes.map((n) => n.id);
  const i = current === null ? -1 : ids.indexOf(current);
  if (i === -1) return direction === 1 ? ids[0]! : ids[ids.length - 1]!;
  return ids[(i + direction + ids.length) % ids.length]!;
}

/** What the hover label and the screen-reader announcement say about a node. */
export function describeNode(scene: Scene, id: string): string {
  const node = scene.nodes.find((n) => n.id === id);
  if (!node) return "";
  const count = neighbors(scene, id).size;
  return `${node.label} · ${KIND_LABEL[node.kind]} · ${count} connection${count === 1 ? "" : "s"}`;
}

/** The workflow step shown at `elapsed` ms, and how far into it (0–1). */
export function phaseAt(elapsed: number): { index: number; progress: number } {
  const t = Math.max(0, elapsed) / PHASE_MS;
  return { index: Math.floor(t) % PHASES.length, progress: t % 1 };
}
