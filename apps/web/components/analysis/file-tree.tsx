"use client";

import { useEffect, useState } from "react";
import { ChevronRight, File, Folder, FolderOpen } from "lucide-react";
import { Skeleton } from "../ui/skeleton";
import { api } from "@/lib/api-client";
import { cn, formatBytes } from "@/lib/utils";
import type { TreeNode } from "./types";

function Node({ node, depth, defaultOpen }: { node: TreeNode; depth: number; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const pad = { paddingLeft: `${depth * 16 + 8}px` };

  if (node.type === "file") {
    return (
      <li role="treeitem" aria-selected={false} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-muted/60" style={pad}>
        <span className="w-3.5" />
        <File className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="truncate font-mono text-xs">{node.name}</span>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{formatBytes(node.size)}</span>
      </li>
    );
  }

  return (
    <li role="treeitem" aria-expanded={open} aria-selected={false}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center gap-2 rounded px-2 py-1 text-left hover:bg-muted/60"
        style={pad}
      >
        <ChevronRight className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")} />
        {open ? <FolderOpen className="size-3.5 shrink-0 text-primary" /> : <Folder className="size-3.5 shrink-0 text-primary" />}
        <span className="truncate font-mono text-xs">{node.name}/</span>
        <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">{node.fileCount} files</span>
      </button>
      {open && (
        <ul role="group">
          {node.children!.map((child) => (
            <Node key={child.path} node={child} depth={depth + 1} defaultOpen={false} />
          ))}
        </ul>
      )}
    </li>
  );
}

export function FileTree({ analysisId }: { analysisId: string }) {
  const [tree, setTree] = useState<TreeNode | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ tree: TreeNode }>(`/api/analysis/${analysisId}/files?view=tree`)
      .then((d) => setTree(d.tree))
      .catch((e: Error) => setError(e.message));
  }, [analysisId]);

  if (error) return <p className="text-sm text-sev-critical">{error}</p>;
  if (!tree)
    return (
      <div className="flex flex-col gap-2">
        {Array.from({ length: 6 }, (_, i) => (
          <Skeleton key={i} className="h-5" style={{ width: `${80 - i * 8}%` }} />
        ))}
      </div>
    );
  if (!tree.children?.length) return <p className="text-sm text-muted-foreground">No files.</p>;

  return (
    <ul role="tree" aria-label="Repository files" className="max-h-[520px] overflow-auto rounded-lg border py-1">
      {tree.children.map((child) => (
        <Node key={child.path} node={child} depth={0} defaultOpen={false} />
      ))}
    </ul>
  );
}
