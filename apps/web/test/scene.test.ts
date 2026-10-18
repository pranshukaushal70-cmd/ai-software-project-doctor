import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { HeroPoster } from "@/components/landing/hero-poster";
import { SceneSteps } from "@/components/landing/scene-steps";
import { buildScene, describeNode, hitTest, neighbors, PHASE_MS, PHASES, phaseAt, project, stepNode, type Scene, type View } from "@/lib/scene";

const VIEW: View = { yaw: 0.6, pitch: -0.2, width: 600, height: 600 };

describe("hero scene geometry", () => {
  it("builds the same small, connected graph on every call", () => {
    const scene = buildScene();
    expect(buildScene()).toEqual(scene);
    expect(scene.nodes).toHaveLength(25); // the core, 8 modules, 2 files or packages each
    expect(new Set(scene.nodes.map((n) => n.id)).size).toBe(scene.nodes.length);
    const ids = new Set(scene.nodes.map((n) => n.id));
    expect(scene.edges.every((e) => ids.has(e.from) && ids.has(e.to))).toBe(true);
    expect(scene.nodes.filter((n) => n.id !== "core").every((n) => neighbors(scene, n.id).size > 0)).toBe(true);
    expect(buildScene({ particles: 10 }).particles).toHaveLength(10);
  });

  it("is an illustration: no labels that read like real results", () => {
    const text = JSON.stringify(buildScene()).toLowerCase();
    for (const word of ["score", "critical", "vulnerab", "passed", "failed", "%"]) expect(text).not.toContain(word);
  });

  it("projects the core to the centre, with perspective by depth", () => {
    const scene = buildScene();
    const core = project(scene.nodes[0]!, VIEW);
    expect(core).toMatchObject({ x: 300, y: 300, k: 1 });
    const front = project({ x: 0, y: 0, z: 1 }, { ...VIEW, yaw: 0, pitch: 0 });
    const back = project({ x: 0, y: 0, z: -1 }, { ...VIEW, yaw: 0, pitch: 0 });
    expect(front.k).toBeGreaterThan(1);
    expect(back.k).toBeLessThan(1);
  });

  it("hit-tests nodes, preferring the one nearest the viewer", () => {
    const scene = buildScene();
    expect(hitTest(scene, VIEW, 300, 300)?.id).toBe("core");
    expect(hitTest(scene, VIEW, 2, 2)).toBeNull();
    // Two nodes on the same line of sight: the nearer one wins.
    const stacked: Scene = { ...scene, nodes: [
      { id: "back", label: "back", kind: "source", x: 0, y: 0, z: -1 },
      { id: "front", label: "front", kind: "source", x: 0, y: 0, z: 1 },
    ] };
    expect(hitTest(stacked, { ...VIEW, yaw: 0, pitch: 0 }, 300, 300)?.id).toBe("front");
  });

  it("describes nodes by path, kind and connections", () => {
    const scene = buildScene();
    // routes.ts: its module, session.ts, client.ts, express, and two importers (Dashboard.tsx, api.test.ts).
    expect(describeNode(scene, "src/api/routes.ts")).toBe("src/api/routes.ts · source file · 6 connections");
    expect(describeNode(scene, "express")).toBe("express · package · 2 connections");
    expect(describeNode(scene, "missing")).toBe("");
  });

  it("steps through every node with the arrow keys, wrapping around", () => {
    const scene = buildScene();
    const ids = scene.nodes.map((n) => n.id);
    expect(stepNode(scene, null, 1)).toBe("core");
    expect(stepNode(scene, null, -1)).toBe(ids.at(-1));
    expect(stepNode(scene, "core", 1)).toBe(ids[1]);
    expect(stepNode(scene, "core", -1)).toBe(ids.at(-1));
    expect(stepNode(scene, ids.at(-1)!, 1)).toBe("core");
  });

  it("walks the five workflow steps in order and starts over", () => {
    expect(phaseAt(0)).toEqual({ index: 0, progress: 0 });
    expect(phaseAt(PHASE_MS * 2.5)).toEqual({ index: 2, progress: 0.5 });
    expect(phaseAt(PHASE_MS * PHASES.length).index).toBe(0);
    expect(phaseAt(-5).index).toBe(0);
  });
});

describe("hero fallback markup", () => {
  it("renders the static poster as decorative SVG, without a browser", () => {
    const html = renderToStaticMarkup(createElement(HeroPoster));
    expect(html).toMatch(/^<svg[^>]*aria-hidden="true"/);
    expect(html.match(/<circle/g)!.length).toBe(40 + 25); // particles and nodes
    expect(html.match(/<line/g)!.length).toBe(buildScene().edges.length);
  });

  it("lists the workflow steps and marks only the active one", () => {
    const html = renderToStaticMarkup(createElement(SceneSteps, { active: 3 }));
    for (const step of PHASES) expect(html).toContain(step);
    expect(html.match(/border-primary\/50/g)).toHaveLength(1);
    expect(renderToStaticMarkup(createElement(SceneSteps, { active: null }))).not.toContain("border-primary/50");
  });
});
