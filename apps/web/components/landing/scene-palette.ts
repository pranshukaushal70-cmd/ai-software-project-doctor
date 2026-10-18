import type { NodeKind } from "@/lib/scene";

/** RGB triplets for the hero illustration, matching the `.stage` tokens in globals.css. */
export const RGB = {
  cyan: "64, 214, 224",
  teal: "45, 212, 191",
  violet: "167, 139, 250",
  amber: "245, 191, 79",
  green: "74, 222, 128",
  slate: "148, 163, 184",
  white: "236, 254, 255",
} as const;

export const KIND_RGB: Record<NodeKind, string> = {
  core: RGB.cyan,
  module: RGB.cyan,
  source: RGB.cyan,
  test: RGB.teal,
  package: RGB.violet,
  config: RGB.slate,
};
