import type { Severity } from "@pd/shared/constants";
import { cvss3BaseScore, cvssSeverity } from "./cvss";
import type { Ecosystem } from "./types";

/**
 * Client for the OSV.dev vulnerability database (https://osv.dev, Apache-2.0 data).
 * The network is used only through the injected `fetch`, so the analyzer stays
 * pure and tests never touch the network. Only ecosystem, package name and exact
 * version are sent (the caller leaves out packages known to come from a private
 * registry); responses are untrusted and validated field by field.
 */
export const OSV_API = "https://api.osv.dev/v1";
export const OSV_DATA_SOURCE = "osv.dev";

export interface OsvOptions {
  fetch: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Overall time budget for the lookup; remaining advisory details are skipped once it is spent. */
  budgetMs?: number;
  /** Upper bound on advisory detail requests. */
  maxDetails?: number;
  concurrency?: number;
}

export interface OsvQuery {
  ecosystem: Ecosystem;
  name: string;
  version: string;
}

export interface OsvAdvisory {
  id: string;
  /** CVE and other identifiers of the same issue. */
  aliases: string[];
  summary: string;
  severity: Severity;
  /** CVSS v3 base score when the advisory has a CVSS v3 vector. */
  score: number | null;
  /** How `severity` was determined. */
  severitySource: "cvss-v3" | "advisory" | "unknown";
  /** Fixed versions per affected package, for upgrade advice. */
  affected: Array<{ ecosystem: string; name: string; fixed: string[] }>;
  url: string;
  /** False when the details could not be fetched (time budget or error): only the id is known. */
  detailed: boolean;
}

export interface OsvLookup {
  status: "completed" | "partial" | "failed";
  /** Advisory ids per `queryKey(query)`. */
  vulnsByPackage: Map<string, string[]>;
  advisories: Map<string, OsvAdvisory>;
  queried: number;
  error: string | null;
  durationMs: number;
}

export const queryKey = (q: { ecosystem: string; name: string; version: string }) => `${q.ecosystem}\0${q.name}\0${q.version}`;

const BATCH_SIZE = 1000;
const MAX_RESPONSE_BYTES = 32 * 1024 * 1024;
const MAX_SUMMARY = 240;

const isRecord = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
/** Advisory text is third-party input: single line, bounded, and without backticks (evidence renders them as code). */
const clean = (s: string, max = MAX_SUMMARY) => {
  const t = s.replace(/\s+/g, " ").replace(/`/g, "'").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

class OsvError extends Error {}

async function requestJson(opts: OsvOptions, url: string, init: RequestInit): Promise<unknown> {
  let res: Response;
  try {
    res = await opts.fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(opts.timeoutMs ?? 15_000) });
  } catch (err) {
    const name = (err as Error)?.name;
    throw new OsvError(name === "TimeoutError" || name === "AbortError" ? "OSV.dev did not respond in time" : "OSV.dev could not be reached");
  }
  if (!res.ok) throw new OsvError(`OSV.dev returned HTTP ${res.status}`);
  const length = Number(res.headers.get("content-length") ?? 0);
  if (length > MAX_RESPONSE_BYTES) throw new OsvError("OSV.dev response was too large");
  const text = await res.text();
  if (text.length > MAX_RESPONSE_BYTES) throw new OsvError("OSV.dev response was too large");
  try {
    return JSON.parse(text);
  } catch {
    throw new OsvError("OSV.dev returned an invalid response");
  }
}

/** OSV expects Go versions without the leading `v` used in go.mod. */
const osvVersion = (q: OsvQuery) => (q.ecosystem === "Go" ? q.version.replace(/^v/, "") : q.version);

const DB_SEVERITY: Record<string, Severity> = { CRITICAL: "CRITICAL", HIGH: "HIGH", MODERATE: "MEDIUM", MEDIUM: "MEDIUM", LOW: "LOW" };

export function parseAdvisory(raw: unknown): OsvAdvisory | null {
  if (!isRecord(raw)) return null;
  const id = str(raw.id);
  if (!id || !/^[\w.:-]{1,100}$/.test(id) || raw.withdrawn) return null;
  const aliases = Array.isArray(raw.aliases) ? raw.aliases.filter((a): a is string => typeof a === "string" && /^[\w.:-]{1,100}$/.test(a)).slice(0, 10) : [];
  const summary = clean(str(raw.summary) ?? str(raw.details)?.split(/\n\s*\n/)[0] ?? "No summary provided.");

  let score: number | null = null;
  if (Array.isArray(raw.severity)) {
    for (const s of raw.severity) {
      if (isRecord(s) && s.type === "CVSS_V3" && typeof s.score === "string") {
        const v = cvss3BaseScore(s.score);
        if (v !== null && (score === null || v > score)) score = v;
      }
    }
  }
  let severity: Severity = "MEDIUM";
  let severitySource: OsvAdvisory["severitySource"] = "unknown";
  if (score !== null) {
    severity = cvssSeverity(score);
    severitySource = "cvss-v3";
  } else {
    const candidates = [raw.database_specific, ...(Array.isArray(raw.affected) ? raw.affected.flatMap((a) => (isRecord(a) ? [a.database_specific, a.ecosystem_specific] : [])) : [])];
    for (const c of candidates) {
      const s = isRecord(c) ? str(c.severity)?.toUpperCase() : null;
      if (s && DB_SEVERITY[s]) {
        severity = DB_SEVERITY[s];
        severitySource = "advisory";
        break;
      }
    }
  }

  const affected: OsvAdvisory["affected"] = [];
  if (Array.isArray(raw.affected)) {
    for (const a of raw.affected.slice(0, 100)) {
      if (!isRecord(a) || !isRecord(a.package)) continue;
      const ecosystem = str(a.package.ecosystem);
      const name = str(a.package.name);
      if (!ecosystem || !name) continue;
      const fixed = new Set<string>();
      if (Array.isArray(a.ranges)) {
        for (const r of a.ranges) {
          if (!isRecord(r) || r.type === "GIT" || !Array.isArray(r.events)) continue;
          for (const e of r.events) if (isRecord(e) && typeof e.fixed === "string" && e.fixed.length <= 100) fixed.add(e.fixed);
        }
      }
      affected.push({ ecosystem, name, fixed: [...fixed] });
    }
  }
  return { id, aliases, summary, severity, score, severitySource, affected, url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`, detailed: true };
}

const placeholder = (id: string): OsvAdvisory => ({
  id,
  aliases: [],
  summary: "Details could not be retrieved from OSV.dev; open the advisory for its description and severity.",
  severity: "MEDIUM",
  score: null,
  severitySource: "unknown",
  affected: [],
  url: `https://osv.dev/vulnerability/${encodeURIComponent(id)}`,
  detailed: false,
});

/** Look up known vulnerabilities for exact package versions. Never throws. */
export async function lookupVulnerabilities(queries: readonly OsvQuery[], opts: OsvOptions): Promise<OsvLookup> {
  const started = performance.now();
  const deadline = started + (opts.budgetMs ?? 90_000);
  const vulnsByPackage = new Map<string, string[]>();
  const advisories = new Map<string, OsvAdvisory>();
  const unique = [...new Map(queries.map((q) => [queryKey(q), q])).values()];
  let error: string | null = null;
  let failedBatches = 0;
  let partial = false;

  for (let i = 0; i < unique.length; i += BATCH_SIZE) {
    const batch = unique.slice(i, i + BATCH_SIZE);
    if (performance.now() > deadline) {
      failedBatches++;
      error ??= "The vulnerability lookup ran out of time";
      continue;
    }
    try {
      const body = await requestJson(opts, `${OSV_API}/querybatch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ queries: batch.map((q) => ({ package: { ecosystem: q.ecosystem, name: q.name }, version: osvVersion(q) })) }),
      });
      const results = isRecord(body) && Array.isArray(body.results) ? body.results : null;
      if (!results || results.length !== batch.length) throw new OsvError("OSV.dev returned an unexpected response");
      results.forEach((r, j) => {
        if (!isRecord(r)) return;
        // More than one page of advisories for a single package version is extremely rare; the first page is used.
        if (r.next_page_token) partial = true;
        const ids = Array.isArray(r.vulns)
          ? r.vulns.map((v) => (isRecord(v) ? str(v.id) : null)).filter((id): id is string => !!id && /^[\w.:-]{1,100}$/.test(id))
          : [];
        if (ids.length > 0) vulnsByPackage.set(queryKey(batch[j]!), [...new Set(ids)]);
      });
    } catch (err) {
      failedBatches++;
      error ??= err instanceof OsvError ? err.message : "The vulnerability lookup failed";
    }
  }

  // Advisory details (summary, severity, fixed versions), with bounded concurrency.
  const ids = [...new Set([...vulnsByPackage.values()].flat())].sort();
  const maxDetails = opts.maxDetails ?? 400;
  let next = 0;
  const worker = async () => {
    while (next < ids.length) {
      const id = ids[next++]!;
      if (next > maxDetails || performance.now() > deadline) {
        advisories.set(id, placeholder(id));
        partial = true;
        continue;
      }
      try {
        advisories.set(id, parseAdvisory(await requestJson(opts, `${OSV_API}/vulns/${encodeURIComponent(id)}`, { method: "GET" })) ?? placeholder(id));
      } catch {
        advisories.set(id, placeholder(id));
        partial = true;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(opts.concurrency ?? 6, ids.length) }, worker));

  const batches = Math.ceil(unique.length / BATCH_SIZE);
  const status = failedBatches > 0 && failedBatches === batches ? "failed" : failedBatches > 0 || partial ? "partial" : "completed";
  if (status === "partial" && !error) error = "Some advisory details could not be retrieved";
  return { status, vulnsByPackage, advisories, queried: unique.length, error, durationMs: Math.round(performance.now() - started) };
}

/**
 * Loose version ordering for choosing an upgrade target: numeric segments are
 * compared numerically, a pre-release sorts before its release. Ecosystem
 * specifics (PEP 440 epochs, Maven qualifiers) are approximated.
 */
export function compareVersions(a: string, b: string): number {
  const split = (v: string) => {
    const [main, pre] = v.replace(/^v/, "").split(/[-+]/, 2) as [string, string | undefined];
    return { parts: main.split(/[._]/), pre };
  };
  const x = split(a);
  const y = split(b);
  for (let i = 0; i < Math.max(x.parts.length, y.parts.length); i++) {
    const p = x.parts[i] ?? "0";
    const q = y.parts[i] ?? "0";
    const pn = /^\d+$/.test(p) ? Number(p) : NaN;
    const qn = /^\d+$/.test(q) ? Number(q) : NaN;
    const c = !Number.isNaN(pn) && !Number.isNaN(qn) ? pn - qn : p.localeCompare(q);
    if (c !== 0) return Math.sign(c);
  }
  if (x.pre && !y.pre) return -1;
  if (!x.pre && y.pre) return 1;
  return (x.pre ?? "").localeCompare(y.pre ?? "");
}

/** Lowest fixed version above `current` for this package across its advisories, if any. */
export function fixedVersionFor(advisories: readonly OsvAdvisory[], ecosystem: string, name: string, current: string): string | null {
  const norm = (n: string) => (ecosystem === "PyPI" ? n.toLowerCase().replace(/[-_.]+/g, "-") : n);
  const cur = ecosystem === "Go" ? current.replace(/^v/, "") : current;
  let needed: string | null = null;
  for (const adv of advisories) {
    const candidates = adv.affected
      .filter((a) => a.ecosystem.split(":")[0] === ecosystem && norm(a.name) === norm(name))
      .flatMap((a) => a.fixed)
      .filter((f) => compareVersions(f, cur) > 0)
      .sort(compareVersions);
    // Each advisory must be fixed, so the target is the highest of the per-advisory minimum fixes.
    const min = candidates[0];
    if (!min) return null;
    if (!needed || compareVersions(min, needed) > 0) needed = min;
  }
  return needed && ecosystem === "Go" && current.startsWith("v") ? `v${needed}` : needed;
}
