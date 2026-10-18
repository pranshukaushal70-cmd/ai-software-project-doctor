"use client";

import { useEffect, useRef, useState } from "react";
import { buildScene, DEFAULT_VIEW, describeNode, hitTest, neighbors, nodeRadius, phaseAt, project, stepNode, type View } from "@/lib/scene";
import { KIND_RGB, RGB } from "./scene-palette";

const BASE_YAW = DEFAULT_VIEW.yaw;
const BASE_PITCH = DEFAULT_VIEW.pitch;
/** Below this frame width the scene drops the code fragments and labels and uses fewer particles. */
const COMPACT_PX = 420;
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A soft round glow, rendered once per colour: far cheaper than `shadowBlur` on every frame. */
function glowSprite(rgb: string): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, `rgba(${rgb}, 0.55)`);
  grad.addColorStop(0.4, `rgba(${rgb}, 0.16)`);
  grad.addColorStop(1, `rgba(${rgb}, 0)`);
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return c;
}

/**
 * The interactive hero illustration (loaded lazily by HeroVisual). A 2D canvas with real
 * perspective: drag to orbit, hover or tap a node for its label, click to highlight its
 * connections, arrow keys to step through the nodes. With reduced motion it draws a still
 * frame and redraws only when the user interacts.
 */
export default function HeroScene({ onReady, onPhase }: { onReady: () => void; onPhase: (index: number | null) => void }) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const keys = useRef<{ step(direction: 1 | -1): void; clear(): void } | null>(null);
  const [announcement, setAnnouncement] = useState("");
  const [ready, setReady] = useState(false);
  const callbacks = useRef({ onReady, onPhase });
  useEffect(() => {
    callbacks.current = { onReady, onPhase };
  });

  useEffect(() => {
    const wrap = wrapRef.current!;
    const canvas = canvasRef.current!;
    const tip = tipRef.current!;
    const ctx = canvas.getContext("2d");
    if (!ctx) return; // No canvas: the static poster behind stays visible.

    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
    const mono = getComputedStyle(document.documentElement).getPropertyValue("--font-jetbrains").trim() || "ui-monospace, monospace";
    let small = wrap.clientWidth < COMPACT_PX;
    let scene = buildScene({ particles: small ? 36 : 70 });
    const sprites = new Map<string, HTMLCanvasElement>();
    const sprite = (rgb: string) => sprites.get(rgb) ?? sprites.set(rgb, glowSprite(rgb)).get(rgb)!;

    const view: View = { yaw: BASE_YAW, pitch: BASE_PITCH, width: 0, height: 0 };
    const start = performance.now();
    let last = start;
    let orbit = 0;
    let dragYaw = 0;
    let dragPitch = 0;
    let parX = 0;
    let parY = 0;
    let targetX = 0;
    let targetY = 0;
    let hovered: string | null = null;
    let selected: string | null = null;
    let drag: { x: number; y: number; yaw: number; pitch: number; moved: boolean } | null = null;
    let raf = 0;
    let onScreen = true;
    let shownPhase: number | null | undefined;
    let shownTip: string | null = null;
    let drawn = false;

    const resize = () => {
      const w = wrap.clientWidth;
      const h = wrap.clientHeight;
      const dpr = Math.min(2, window.devicePixelRatio || 1);
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      view.width = w;
      view.height = h;
      if (w < COMPACT_PX !== small) {
        small = w < COMPACT_PX;
        scene = buildScene({ particles: small ? 36 : 70 });
      }
    };

    const drawCore = (x: number, y: number, k: number, t: number, animate: boolean) => {
      const r = nodeRadius("core", k) * (animate ? 1 + Math.sin(t * 1.8) * 0.05 : 1);
      const glow = ctx.createRadialGradient(x, y, 0, x, y, r * 3.2);
      glow.addColorStop(0, `rgba(${RGB.white}, 0.95)`);
      glow.addColorStop(0.22, `rgba(${RGB.cyan}, 0.85)`);
      glow.addColorStop(0.55, `rgba(${RGB.violet}, 0.22)`);
      glow.addColorStop(1, `rgba(${RGB.violet}, 0)`);
      ctx.fillStyle = glow;
      ctx.beginPath();
      ctx.arc(x, y, r * 3.2, 0, Math.PI * 2);
      ctx.fill();
      ctx.lineWidth = 1.5;
      for (const [radius, rgb, speed, offset] of [[1.75, RGB.cyan, 0.6, 0], [2.3, RGB.violet, -0.4, 2]] as const) {
        const a = (animate ? t * speed : 0) + offset;
        ctx.strokeStyle = `rgba(${rgb}, 0.65)`;
        ctx.beginPath();
        ctx.arc(x, y, r * radius, a, a + 1.5);
        ctx.stroke();
        ctx.beginPath();
        ctx.arc(x, y, r * radius, a + Math.PI, a + Math.PI + 0.7);
        ctx.stroke();
      }
    };

    const draw = (now: number) => {
      const animate = !reduce.matches;
      const elapsed = now - start;
      const t = elapsed / 1000;
      const phase = animate ? phaseAt(elapsed) : null;
      if ((phase?.index ?? null) !== shownPhase) {
        shownPhase = phase?.index ?? null;
        callbacks.current.onPhase(shownPhase);
      }
      view.yaw = BASE_YAW + orbit + dragYaw + parX;
      view.pitch = clamp(BASE_PITCH + dragPitch + parY, -0.9, 0.6);
      const { width: w, height: h } = view;
      ctx.clearRect(0, 0, w, h);

      const at = new Map(scene.nodes.map((n) => [n.id, project(n, view)]));
      const core = at.get("core")!;
      const halo = ctx.createRadialGradient(core.x, core.y, 0, core.x, core.y, Math.min(w, h) * 0.5);
      halo.addColorStop(0, `rgba(${RGB.cyan}, 0.1)`);
      halo.addColorStop(0.55, `rgba(${RGB.violet}, 0.045)`);
      halo.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.fillStyle = halo;
      ctx.fillRect(0, 0, w, h);

      const focus = selected ?? hovered;
      const near = focus ? neighbors(scene, focus) : null;
      const lit = (id: string) => !near || id === focus || near.has(id);
      const depth = (z: number) => clamp(0.6 + z / 5, 0.2, 1);

      for (const p of scene.particles) {
        const q = project({ x: p.x, y: p.y + (animate ? Math.sin(t * 0.6 + p.phase) * 0.06 : 0), z: p.z }, view);
        ctx.fillStyle = `rgba(${RGB.cyan}, ${0.3 * depth(q.z)})`;
        ctx.beginPath();
        ctx.arc(q.x, q.y, 1.1 * q.k, 0, Math.PI * 2);
        ctx.fill();
      }
      if (!small) {
        ctx.font = `11px ${mono}`;
        for (const f of scene.fragments) {
          const q = project(f, view);
          // Skip a fragment rather than clip it at the frame's edge.
          if (q.x < 6 || q.x + ctx.measureText(f.text).width > w - 6 || q.y < 14 || q.y > h - 6) continue;
          ctx.fillStyle = `rgba(${RGB.slate}, ${0.2 * depth(q.z)})`;
          ctx.fillText(f.text, q.x, q.y);
        }
      }

      const plan = new Set(scene.marked.plan);
      ctx.lineWidth = 1;
      for (const e of scene.edges) {
        const a = at.get(e.from)!;
        const b = at.get(e.to)!;
        const inPlan = phase?.index === 3 && plan.has(e.from) && plan.has(e.to);
        const touches = focus !== null && (e.from === focus || e.to === focus);
        const rgb = inPlan ? RGB.violet : RGB.cyan;
        const alpha = near ? (touches ? 0.8 : 0.05) : inPlan ? 0.75 : 0.22 * depth((a.z + b.z) / 2);
        ctx.strokeStyle = `rgba(${rgb}, ${alpha})`;
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
        if (animate && (touches || inPlan || (phase?.index === 1 && !near))) {
          const s = (t * 0.45 + e.offset) % 1;
          ctx.fillStyle = `rgba(${rgb}, 0.9)`;
          ctx.beginPath();
          ctx.arc(a.x + (b.x - a.x) * s, a.y + (b.y - a.y) * s, 1.7, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      const revealed = phase?.index === 0 ? Math.floor(phase.progress * scene.nodes.length) : scene.nodes.length;
      const order = scene.nodes.map((n, i) => ({ n, i, p: at.get(n.id)! })).sort((a, b) => a.p.z - b.p.z);
      for (const { n, i, p } of order) {
        if (n.kind === "core") {
          drawCore(p.x, p.y, p.k, t, animate);
          continue;
        }
        const rgb = KIND_RGB[n.kind];
        const r = nodeRadius(n.kind, p.k);
        ctx.globalAlpha = depth(p.z) * (i <= revealed ? 1 : 0.25) * (lit(n.id) ? 1 : 0.25);
        const g = r * 5;
        ctx.drawImage(sprite(rgb), p.x - g, p.y - g, g * 2, g * 2);
        ctx.fillStyle = `rgb(${rgb})`;
        ctx.beginPath();
        ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 1;
        const mark = phase?.index === 2 && scene.marked.findings.includes(n.id) ? RGB.amber : phase?.index === 4 && scene.marked.review.includes(n.id) ? RGB.green : null;
        if (mark || n.id === focus) {
          ctx.strokeStyle = mark ? `rgba(${mark}, 0.9)` : `rgba(${RGB.white}, 0.9)`;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, r + 4 + (animate && mark ? Math.sin(t * 4) * 1.2 : 0), 0, Math.PI * 2);
          ctx.stroke();
          ctx.lineWidth = 1;
        }
      }

      // Module labels, nearest first; a label is skipped if it would overlap one already
      // placed, sit on the core's glow or leave the frame, so they never pile up.
      if (!small) {
        ctx.font = `11px ${mono}`;
        const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
        const coreR = nodeRadius("core", core.k) * 3;
        for (const { n, p } of [...order].reverse()) {
          if (n.kind !== "module" || p.z < -0.6) continue;
          const box = { x: p.x + nodeRadius(n.kind, p.k) + 6, y: p.y - 8, w: ctx.measureText(n.label).width, h: 12 };
          const overlaps = placed.some((o) => box.x < o.x + o.w + 6 && box.x + box.w + 6 > o.x && box.y < o.y + o.h + 3 && box.y + box.h + 3 > o.y);
          const onCore = Math.hypot(Math.max(core.x - (box.x + box.w), box.x - core.x, 0), Math.max(core.y - (box.y + box.h), box.y - core.y, 0)) < coreR;
          if (overlaps || onCore || box.x + box.w > w - 6 || box.y < 2 || box.y + box.h > h - 2) continue;
          placed.push(box);
          ctx.fillStyle = `rgba(${RGB.slate}, ${0.8 * depth(p.z) * (lit(n.id) ? 1 : 0.35)})`;
          ctx.fillText(n.label, box.x, p.y + 4);
        }
      }

      if (focus) {
        const p = at.get(focus)!;
        if (shownTip !== focus) {
          tip.textContent = describeNode(scene, focus);
          shownTip = focus;
        }
        tip.style.transform = `translate(${clamp(p.x, 90, w - 90)}px, ${Math.max(8, p.y - nodeRadius(scene.nodes.find((n) => n.id === focus)!.kind, p.k) - 34)}px) translateX(-50%)`;
        tip.style.opacity = "1";
      } else if (shownTip !== null) {
        tip.style.opacity = "0";
        shownTip = null;
      }
      if (!drawn) {
        drawn = true;
        setReady(true);
        callbacks.current.onReady();
      }
    };

    const frame = (now: number) => {
      const dt = Math.min(64, now - last);
      last = now;
      if (!reduce.matches) {
        if (!drag) orbit += dt * 0.00006;
        parX += (targetX - parX) * 0.06;
        parY += (targetY - parY) * 0.06;
      }
      draw(now);
      raf = onScreen && !document.hidden && !reduce.matches ? requestAnimationFrame(frame) : 0;
    };
    const kick = () => {
      if (!raf) {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };

    const select = (id: string | null) => {
      selected = id;
      setAnnouncement(id ? describeNode(scene, id) : "Selection cleared");
      kick();
    };
    keys.current = { step: (direction) => select(stepNode(scene, selected, direction)), clear: () => select(null) };

    const local = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    };
    const onMove = (e: PointerEvent) => {
      const { x, y } = local(e);
      targetX = (x / view.width - 0.5) * 0.35;
      targetY = (y / view.height - 0.5) * 0.18;
      if (drag) {
        const dx = x - drag.x;
        const dy = y - drag.y;
        if (Math.abs(dx) + Math.abs(dy) > 4) drag.moved = true;
        dragYaw = drag.yaw + dx * 0.006;
        dragPitch = clamp(drag.pitch + dy * 0.004, -0.6, 0.6);
      } else {
        const hit = hitTest(scene, view, x, y);
        hovered = hit?.id ?? null;
        canvas.style.cursor = hit ? "pointer" : "grab";
      }
      kick();
    };
    const onDown = (e: PointerEvent) => {
      const { x, y } = local(e);
      drag = { x, y, yaw: dragYaw, pitch: dragPitch, moved: false };
      canvas.setPointerCapture(e.pointerId);
    };
    const onUp = (e: PointerEvent) => {
      if (drag && !drag.moved) {
        const { x, y } = local(e);
        const hit = hitTest(scene, view, x, y);
        select(hit && hit.id !== selected ? hit.id : null);
      }
      drag = null;
      kick();
    };
    const onCancel = () => {
      drag = null;
    };
    const onLeave = () => {
      hovered = null;
      targetX = 0;
      targetY = 0;
      kick();
    };
    canvas.addEventListener("pointermove", onMove);
    canvas.addEventListener("pointerdown", onDown);
    canvas.addEventListener("pointerup", onUp);
    canvas.addEventListener("pointercancel", onCancel);
    canvas.addEventListener("pointerleave", onLeave);

    const resizer = new ResizeObserver(() => {
      resize();
      kick();
    });
    resizer.observe(wrap);
    const visibility = new IntersectionObserver(([entry]) => {
      onScreen = entry?.isIntersecting ?? true;
      if (onScreen) kick();
    });
    visibility.observe(wrap);
    const onVisible = () => !document.hidden && kick();
    document.addEventListener("visibilitychange", onVisible);
    reduce.addEventListener("change", kick);
    resize();
    kick();

    return () => {
      cancelAnimationFrame(raf);
      resizer.disconnect();
      visibility.disconnect();
      document.removeEventListener("visibilitychange", onVisible);
      reduce.removeEventListener("change", kick);
      canvas.removeEventListener("pointermove", onMove);
      canvas.removeEventListener("pointerdown", onDown);
      canvas.removeEventListener("pointerup", onUp);
      canvas.removeEventListener("pointercancel", onCancel);
      canvas.removeEventListener("pointerleave", onLeave);
      keys.current = null;
    };
  }, []);

  const onKeyDown = (e: React.KeyboardEvent) => {
    const k = keys.current;
    if (!k) return;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") k.step(1);
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") k.step(-1);
    else if (e.key === "Escape") k.clear();
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={wrapRef}
      tabIndex={0}
      role="group"
      aria-roledescription="interactive illustration"
      aria-label="Illustration of a repository dependency network around the AI core"
      aria-describedby="hero-scene-help"
      onKeyDown={onKeyDown}
      className={`absolute inset-0 rounded-3xl outline-none transition-opacity duration-700 focus-visible:ring-2 focus-visible:ring-ring ${ready ? "opacity-100" : "opacity-0"}`}
    >
      <canvas ref={canvasRef} className="size-full touch-pan-y" style={{ cursor: "grab" }} />
      <div
        ref={tipRef}
        aria-hidden
        className="pointer-events-none absolute left-0 top-0 whitespace-nowrap rounded-md border border-primary/30 bg-card/90 px-2 py-1 font-mono text-[11px] text-foreground opacity-0 shadow-lg backdrop-blur transition-opacity duration-150"
      />
      <p className="sr-only" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
