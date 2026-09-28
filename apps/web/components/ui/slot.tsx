import { cloneElement, isValidElement } from "react";
import { cn } from "@/lib/utils";

/** Minimal Radix-style Slot: merges props/className onto its single child element. */
export function Slot({ children, className, ...props }: React.HTMLAttributes<HTMLElement> & { children?: React.ReactNode }) {
  if (!isValidElement<{ className?: string }>(children)) return null;
  return cloneElement(children, { ...props, className: cn(className, children.props.className) });
}
