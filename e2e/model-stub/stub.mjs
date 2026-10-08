// Deterministic stand-in for the Anthropic Messages API, used only by the end-to-end
// stack (docker-compose.e2e.yml). The worker's real provider code (packages/agent,
// AnthropicProvider) talks to it over HTTP through ANTHROPIC_BASE_URL, so everything
// except the model itself is exercised. It answers from the request alone:
//   planner request → a small plan built only from the evidence it was given
//   editor request  → one harmless, exact edit per file in the "modify" scope
// It is not a model: it proves the plumbing, gates and safety checks, not plan or code
// quality (that is the real-model evaluation in benchmarks/, docs/benchmark.md).
// Plain JavaScript without dependencies so it runs in a bare node image.

export const STUB_MODEL = "e2e-model-stub";
export const STUB_COMMENT = "Reviewed by the Project Doctor model stub (end-to-end tests).";

const PLANNER_MARK = "You are the planning stage";
const EDITOR_MARK = "You are the editing stage";

/** Text of the `system` field, whether a string or a list of text blocks. */
export function systemText(body) {
  if (typeof body?.system === "string") return body.system;
  if (Array.isArray(body?.system)) return body.system.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n");
  return "";
}

/** Text of the last user message. */
export function userText(body) {
  const messages = Array.isArray(body?.messages) ? body.messages : [];
  const last = [...messages].reverse().find((m) => m?.role === "user");
  if (!last) return "";
  if (typeof last.content === "string") return last.content;
  if (Array.isArray(last.content)) return last.content.map((b) => (typeof b?.text === "string" ? b.text : "")).join("\n");
  return "";
}

export function requestKind(body) {
  const system = systemText(body);
  if (system.includes(PLANNER_MARK)) return "plan";
  if (system.includes(EDITOR_MARK)) return "edit";
  return null;
}

/** `[stub:refuse]` / `[stub:error]` in the task text select a failure, so failure handling can be tested end to end. */
export function directive(user) {
  const task = /^Developer task: (.*)$/m.exec(user)?.[1] ?? "";
  if (task.includes("[stub:refuse]")) return "refuse";
  if (task.includes("[stub:error]")) return "error";
  return null;
}

// ---------------------------------------------------------------- planning

/** Evidence lines of the planner message: `E3 [SYMBOL] function add is declared in src/math.js:1.` */
export function parseEvidence(user) {
  const items = [];
  for (const line of user.split("\n")) {
    const m = /^(E\d+) \[([A-Z]+)\] (.*)$/.exec(line);
    if (m) items.push({ id: m[1], kind: m[2], summary: m[3] });
  }
  return items;
}

const pathOf = (item) => {
  const patterns = {
    SYMBOL: /^\S+ (\S+) is declared in (\S+):\d+\.$/,
    ROUTE: / is declared in (\S+):\d+\.$/,
    TEST: /^Test (\S+) /,
    IMPORT: /^(\S+) imports /,
  };
  const re = patterns[item.kind];
  if (!re) return null;
  const m = re.exec(item.summary);
  if (!m) return null;
  return item.kind === "SYMBOL" ? m[2] : m[1];
};

const symbolOf = (item) => (item.kind === "SYMBOL" ? /^\S+ (\S+) is declared in /.exec(item.summary)?.[1] ?? null : null);

const isTestPath = (p) => /(^|\/)(tests?|__tests__|spec)\//.test(p) || /\.(test|spec)\.[a-z]+$/.test(p);

export function buildPlan(user) {
  const task = /^Developer task: (.*)$/m.exec(user)?.[1] ?? "the task";
  const evidence = parseEvidence(user);
  const located = evidence.map((e) => ({ ...e, path: pathOf(e), symbol: symbolOf(e) })).filter((e) => e.path);
  const target = located.find((e) => e.kind === "SYMBOL" && !isTestPath(e.path)) ?? located.find((e) => e.kind !== "TEST" && !isTestPath(e.path)) ?? null;
  const tests = [...new Map(located.filter((e) => e.kind === "TEST").map((e) => [e.path, e])).values()].slice(0, 3);

  return {
    taskSummary: task,
    interpretation: target
      ? `Change ${target.path}, the file the evidence connects to the task, and keep its existing tests passing.`
      : "The evidence does not point to a file to change.",
    assumptions: target ? [{ statement: `${target.path} is where the task's behaviour lives.`, certainty: "INFERRED", evidence: [target.id] }] : [],
    affectedFiles: target ? [{ path: target.path, change: "modify", reason: "Named by the evidence for this task.", certainty: "VERIFIED", evidence: [target.id] }] : [],
    affectedSymbols: target?.symbol ? [{ name: target.symbol, path: target.path, change: "modify", reason: "Declared in the file to change.", certainty: "VERIFIED", evidence: [target.id] }] : [],
    architectureImpact: { statement: "The change stays inside one file.", certainty: "INFERRED", evidence: target ? [target.id] : [] },
    implementationSteps: target ? [{ title: `Update ${target.path}`, description: "Make the smallest change the task needs.", files: [target.path], evidence: [target.id] }] : [],
    testPlan: tests.map((t) => ({ description: `Re-run ${t.path} and confirm it still passes.`, path: t.path, kind: "existing", evidence: [t.id] })),
    configurationChanges: [],
    dependencyChanges: [],
    securityConsiderations: [],
    performanceConsiderations: [],
    risks: [],
    validationPlan: ["Run the repository's existing test suite and confirm it passes."],
    unknowns: target ? [] : ["Which file implements the task."],
    confidence: target ? 0.6 : 0.1,
  };
}

// ---------------------------------------------------------------- editing

/** `<file path="…" purpose="…">` blocks of the editor message. */
export function parseFiles(user) {
  const files = [];
  const open = /^<file path="([^"]+)" purpose="([a-z]+)"( redacted="true")?>$/gm;
  let m;
  while ((m = open.exec(user))) {
    const start = m.index + m[0].length + 1;
    const end = user.indexOf("\n</file>", start - 1);
    if (end < 0) break;
    files.push({ path: m[1], purpose: m[2], content: start > end ? "" : user.slice(start, end) });
  }
  return files;
}

export function parseModifyScope(user) {
  const line = /^- modify: (.*)$/m.exec(user)?.[1] ?? "(none)";
  return line === "(none)" ? [] : line.split(", ").map((s) => s.trim());
}

const COMMENT_PREFIX = { js: "//", mjs: "//", cjs: "//", jsx: "//", ts: "//", tsx: "//", java: "//", c: "//", h: "//", cpp: "//", cc: "//", hpp: "//", go: "//", rs: "//", py: "#", rb: "#" };

/** One exact edit: a comment inserted above the first line that occurs exactly once (never a redacted or shebang line). */
export function editFor(file) {
  const prefix = COMMENT_PREFIX[file.path.split(".").pop()?.toLowerCase() ?? ""];
  if (!prefix) return null;
  const lines = file.content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#!") || line.includes("<redacted>") || line.includes(STUB_COMMENT)) continue;
    if (i > 0 && lines[i - 1].includes(STUB_COMMENT)) continue;
    if (file.content.split(line).length !== 2) continue;
    const indent = /^\s*/.exec(line)[0];
    return { find: line, replace: `${indent}${prefix} ${STUB_COMMENT}\n${line}` };
  }
  return null;
}

export function buildEdits(user) {
  const scope = new Set(parseModifyScope(user));
  const changes = [];
  for (const file of parseFiles(user)) {
    if (file.purpose !== "modify" || !scope.has(file.path)) continue;
    const edit = editFor(file);
    if (edit) changes.push({ path: file.path, operation: "modify", reason: "Smallest change that marks the file as reviewed.", edits: [edit], content: null });
  }
  return {
    summary: changes.length ? `Added a review comment to ${changes.map((c) => c.path).join(", ")}.` : "No file in scope could be changed.",
    changes,
    notes: ["Generated by the deterministic end-to-end model stub, not by a model."],
    confidence: changes.length ? 0.5 : 0.1,
  };
}

// ---------------------------------------------------------------- response

let counter = 0;

/** The Messages API response for one request body: `{ status, json }`. */
export function respond(body) {
  const kind = requestKind(body);
  if (!kind) return { status: 400, json: { type: "error", error: { type: "invalid_request_error", message: "The stub only answers planner and editor requests." } } };
  const user = userText(body);
  const which = directive(user);
  if (which === "error") return { status: 500, json: { type: "error", error: { type: "api_error", message: "Scripted stub failure." } } };
  const output = kind === "plan" ? buildPlan(user) : buildEdits(user);
  const text = which === "refuse" ? "" : JSON.stringify(output);
  counter += 1;
  return {
    status: 200,
    json: {
      id: `msg_stub_${String(counter).padStart(6, "0")}`,
      type: "message",
      role: "assistant",
      model: STUB_MODEL,
      content: [{ type: "text", text }],
      stop_reason: which === "refuse" ? "refusal" : "end_turn",
      stop_sequence: null,
      usage: { input_tokens: Math.ceil((systemText(body).length + user.length) / 4), output_tokens: Math.ceil(text.length / 4) },
    },
  };
}
