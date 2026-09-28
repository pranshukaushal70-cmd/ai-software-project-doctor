"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { FileArchive, FolderGit2, Loader2, Lock, UploadCloud } from "lucide-react";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { FormError, Input, Label } from "./ui/form";
import { api } from "@/lib/api-client";
import { cn, formatBytes } from "@/lib/utils";

type Tab = "url" | "zip";

export function NewAnalysisForm({ maxUploadMb }: { maxUploadMb: number }) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("url");
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    let init: RequestInit;
    if (tab === "url") {
      const url = String(new FormData(e.currentTarget).get("url") ?? "");
      init = { method: "POST", body: JSON.stringify({ url, mode: "LOCAL_ONLY" }) };
    } else {
      if (!file) return setError("Choose a .zip file to upload");
      if (file.size > maxUploadMb * 1024 * 1024) return setError(`Archives are limited to ${maxUploadMb} MB`);
      const form = new FormData();
      form.set("file", file);
      form.set("mode", "LOCAL_ONLY");
      init = { method: "POST", body: form };
    }
    setPending(true);
    try {
      const { analysisId } = await api<{ analysisId: string }>("/api/analysis", init);
      router.push(`/analysis/${analysisId}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the analysis");
      setPending(false);
    }
  }

  return (
    <Card className="mt-6">
      <div role="tablist" aria-label="Repository source" className="flex border-b">
        {(
          [
            ["url", FolderGit2, "Repository URL"],
            ["zip", FileArchive, "Upload ZIP"],
          ] as const
        ).map(([id, Icon, label]) => (
          <button
            key={id}
            role="tab"
            type="button"
            aria-selected={tab === id}
            onClick={() => {
              setTab(id);
              setError(null);
            }}
            className={cn(
              "flex flex-1 items-center justify-center gap-2 border-b-2 border-transparent px-4 py-3 text-sm text-muted-foreground transition-colors hover:text-foreground",
              tab === id && "border-primary text-foreground",
            )}
          >
            <Icon className="size-4" /> {label}
          </button>
        ))}
      </div>

      <CardContent className="pt-5">
        <form onSubmit={submit} className="flex flex-col gap-5">
          {tab === "url" ? (
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="url">Public GitHub or GitLab URL</Label>
              <Input id="url" name="url" type="url" required placeholder="https://github.com/owner/repository" className="font-mono" />
              <p className="text-xs text-muted-foreground">
                Add <code className="font-mono">/tree/&lt;branch&gt;</code> to analyse a specific branch.
              </p>
            </div>
          ) : (
            <div>
              <input
                type="file"
                accept=".zip,application/zip"
                className="sr-only"
                id="zip"
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
              />
              <label
                htmlFor="zip"
                onDragOver={(e) => e.preventDefault()}
                onDrop={(e) => {
                  e.preventDefault();
                  setFile(e.dataTransfer.files[0] ?? null);
                }}
                className="flex cursor-pointer flex-col items-center gap-2 rounded-lg border border-dashed px-6 py-10 text-center transition-colors hover:bg-muted/50"
              >
                <UploadCloud className="size-6 text-muted-foreground" />
                {file ? (
                  <span className="text-sm">
                    <span className="font-medium">{file.name}</span>{" "}
                    <span className="text-muted-foreground">({formatBytes(file.size)})</span>
                  </span>
                ) : (
                  <span className="text-sm text-muted-foreground">Drop a .zip here or click to browse (max {maxUploadMb} MB)</span>
                )}
              </label>
            </div>
          )}

          <fieldset className="rounded-lg border p-4">
            <legend className="px-1 text-sm font-medium">Analysis mode</legend>
            <div className="flex items-start gap-3">
              <Lock className="mt-0.5 size-4 text-primary" aria-hidden />
              <div className="text-sm">
                <div className="font-medium">Local-only</div>
                <p className="text-muted-foreground">
                  All analysis runs on this server; no code is sent to any AI provider. AI-assisted mode becomes available once
                  the reasoning engine is enabled. In that mode, redacted findings and selected snippets may be processed by the
                  configured provider; detected secrets are never sent.
                </p>
              </div>
            </div>
          </fieldset>

          <FormError message={error} />
          <Button type="submit" disabled={pending} className="self-start">
            {pending && <Loader2 className="animate-spin" />}
            Start analysis
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
