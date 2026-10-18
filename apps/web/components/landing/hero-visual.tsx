"use client";

import dynamic from "next/dynamic";
import { useState } from "react";
import { cn } from "@/lib/utils";
import { SceneSteps } from "./scene-steps";

// Loaded after hydration in its own chunk, so the canvas never blocks the first render.
const HeroScene = dynamic(() => import("./hero-scene"), { ssr: false });

/**
 * The hero illustration's frame: the server-rendered still (`children`) shows at once and stays
 * as the fallback; the interactive canvas fades in over it once its first frame is drawn.
 */
export function HeroVisual({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [phase, setPhase] = useState<number | null>(null);
  return (
    <div className="flex flex-col items-center gap-4">
      {/* 4:3 when stacked under the text (phones, tablets), square beside it on large screens. */}
      <div className="relative aspect-[4/3] w-full max-w-[600px] lg:aspect-square">
        <div className={cn("pointer-events-none absolute inset-0 transition-opacity duration-700", ready && "opacity-0")}>{children}</div>
        <HeroScene onReady={() => setReady(true)} onPhase={setPhase} />
      </div>
      <SceneSteps active={phase} />
      <p id="hero-scene-help" className="text-center text-xs text-muted-foreground">
        Illustration of the workflow, not results from your repository. Drag to orbit, hover or tap a node, or focus it and use
        the arrow keys.
      </p>
    </div>
  );
}
