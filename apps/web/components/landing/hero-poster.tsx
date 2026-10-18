import { buildScene, DEFAULT_VIEW, nodeRadius, project } from "@/lib/scene";
import { KIND_RGB, RGB } from "./scene-palette";

const SIZE = 600;
const VIEW = { ...DEFAULT_VIEW, width: SIZE, height: SIZE };

/**
 * A still SVG frame of the hero illustration: rendered on the server, shown before the canvas
 * loads, with reduced motion off-canvas, and wherever canvas is unavailable.
 */
export function HeroPoster() {
  const scene = buildScene({ particles: 40 });
  const at = new Map(scene.nodes.map((n) => [n.id, project(n, VIEW)]));
  const nodes = [...scene.nodes].sort((a, b) => at.get(a.id)!.z - at.get(b.id)!.z);
  const depth = (z: number) => Math.min(1, Math.max(0.25, 0.6 + z / 5));

  return (
    // "slice" fills a 4:3 frame like the canvas does: the graph is wider than tall, so only empty space is cropped.
    <svg viewBox={`0 0 ${SIZE} ${SIZE}`} preserveAspectRatio="xMidYMid slice" className="size-full" aria-hidden focusable="false">
      <defs>
        <radialGradient id="poster-core">
          <stop offset="0%" stopColor={`rgb(${RGB.white})`} />
          <stop offset="35%" stopColor={`rgb(${RGB.cyan})`} />
          <stop offset="70%" stopColor={`rgba(${RGB.violet}, 0.35)`} />
          <stop offset="100%" stopColor={`rgba(${RGB.violet}, 0)`} />
        </radialGradient>
      </defs>
      {scene.particles.map((p, i) => {
        const q = project(p, VIEW);
        return <circle key={`p${i}`} cx={q.x} cy={q.y} r={1.2 * q.k} fill={`rgba(${RGB.cyan}, ${0.35 * depth(q.z)})`} />;
      })}
      {scene.edges.map((e) => {
        const a = at.get(e.from)!;
        const b = at.get(e.to)!;
        return <line key={`${e.from}>${e.to}`} x1={a.x} y1={a.y} x2={b.x} y2={b.y} stroke={`rgba(${RGB.cyan}, ${0.28 * depth((a.z + b.z) / 2)})`} strokeWidth={1} />;
      })}
      {nodes.map((n) => {
        const p = at.get(n.id)!;
        if (n.kind === "core") return <circle key={n.id} cx={p.x} cy={p.y} r={nodeRadius("core", p.k) * 3} fill="url(#poster-core)" />;
        return <circle key={n.id} cx={p.x} cy={p.y} r={nodeRadius(n.kind, p.k)} fill={`rgba(${KIND_RGB[n.kind]}, ${depth(p.z)})`} />;
      })}
    </svg>
  );
}
