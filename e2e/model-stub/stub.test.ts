import { buildEditUserMessage, buildUserMessage, EDITOR_SYSTEM_PROMPT, EditOutputSchema, PLANNER_SYSTEM_PROMPT, PlanOutputSchema, type EditContext, type PlanningContext } from "@pd/agent";
import { describe, expect, it } from "vitest";
import { editFor, requestKind, respond, STUB_COMMENT, STUB_MODEL } from "./stub.mjs";

// The stub parses the messages the real prompt builders produce. These tests build them with
// @pd/agent itself, so a prompt change that breaks the end-to-end stub fails here first, and
// its answers are checked against the same output schemas the provider requests.

const planning: PlanningContext = {
  task: { request: "Document the add function", scope: null, constraints: [] },
  repository: { name: "tiny-node", primaryLanguage: "JavaScript", languages: ["JavaScript"], frameworks: [], testFrameworks: ["node:test"], packageManagers: ["npm"], runtimes: [] },
  evidence: [
    { id: "E1", kind: "MANIFEST", path: null, symbol: null, line: null, source: "manifest", summary: "Repository tiny-node: JavaScript." },
    { id: "E2", kind: "SYMBOL", path: "test/math.test.js", symbol: "helper", line: 3, source: "search", summary: "function helper is declared in test/math.test.js:3." },
    { id: "E3", kind: "SYMBOL", path: "src/math.js", symbol: "add", line: 4, source: "search", summary: "function add is declared in src/math.js:4." },
    { id: "E4", kind: "TEST", path: "test/math.test.js", symbol: null, line: null, source: "related-tests", summary: "Test test/math.test.js reaches src/math.js through imports (distance 1)." },
  ],
  stats: { searchHits: 2, candidateFiles: 1, evidence: 4, truncated: false },
} as PlanningContext;

const planBody = (ctx: PlanningContext) => ({
  model: STUB_MODEL,
  system: [{ type: "text", text: PLANNER_SYSTEM_PROMPT }],
  messages: [{ role: "user", content: buildUserMessage(ctx) }],
});

const source = '"use strict";\n\n/** Sum. */\nfunction add(a, b) {\n  return a + b;\n}\n\nmodule.exports = { add };\n';
const editing: EditContext = {
  task: { request: "Document the add function", constraints: [] },
  plan: { summary: "s", interpretation: "i", steps: [], tests: [], dependencyChanges: [], configurationChanges: [] },
  scope: { modify: ["src/math.js"], create: [], delete: [], newTests: false, dependencyChanges: false },
  files: [
    { path: "src/math.js", purpose: "modify", content: source, redacted: false },
    { path: "test/math.test.js", purpose: "test", content: "const x = 1;\n", redacted: false },
  ],
  omitted: [],
  repair: null,
  stats: { files: 2, bytes: source.length, truncated: false },
} as EditContext;

const editBody = (ctx: EditContext) => ({ system: EDITOR_SYSTEM_PROMPT, messages: [{ role: "user", content: [{ type: "text", text: buildEditUserMessage(ctx) }] }] });
const textOf = (json: { content?: { text: string }[] }) => json.content![0]!.text;

describe("model stub", () => {
  it("recognises planner and editor requests by their system prompts", () => {
    expect(requestKind(planBody(planning))).toBe("plan");
    expect(requestKind(editBody(editing))).toBe("edit");
    expect(respond({ system: "something else", messages: [] }).status).toBe(400);
  });

  it("plans the non-test file the evidence names, in the provider's schema", () => {
    const { status, json } = respond(planBody(planning));
    expect(status).toBe(200);
    expect(json.model).toBe(STUB_MODEL);
    const plan = PlanOutputSchema.parse(JSON.parse(textOf(json)));
    expect(plan.affectedFiles).toEqual([expect.objectContaining({ path: "src/math.js", change: "modify", evidence: ["E3"] })]);
    expect(plan.testPlan.map((t) => t.path)).toEqual(["test/math.test.js"]);
  });

  it("answers the same request with the same plan", () => {
    expect(textOf(respond(planBody(planning)).json)).toBe(textOf(respond(planBody(planning)).json));
  });

  it("edits only files in the modify scope, with an exact find/replace", () => {
    const out = EditOutputSchema.parse(JSON.parse(textOf(respond(editBody(editing)).json)));
    expect(out.changes.map((c) => c.path)).toEqual(["src/math.js"]);
    const [edit] = out.changes[0]!.edits!;
    expect(source.split(edit!.find).length).toBe(2);
    expect(edit!.replace).toContain(`// ${STUB_COMMENT}`);
  });

  it("never edits redacted lines and skips files it cannot comment", () => {
    expect(editFor({ path: "a.js", purpose: "modify", content: 'const key = "<redacted>";\nconst b = 2;\n' })?.find).toBe("const b = 2;");
    expect(editFor({ path: "data.json", purpose: "modify", content: "{}\n" })).toBeNull();
  });

  it("scripts failures and refusals from the task text", () => {
    const failing = { ...planning, task: { ...planning.task, request: "Break [stub:error]" } };
    expect(respond(planBody(failing)).status).toBe(500);
    const refusing = { ...planning, task: { ...planning.task, request: "Refuse [stub:refuse]" } };
    const refused = respond(planBody(refusing));
    expect(refused.status).toBe(200);
    expect(refused.json.stop_reason).toBe("refusal");
  });
});
