/**
 * Architecture rule catalogue and thresholds. Thresholds are stored with every
 * analysis (summary.architecture.thresholds) so a result can always be explained.
 */
export const ARCHITECTURE_THRESHOLDS = {
  /** Distinct internal files imported by one file. */
  fanOut: { low: 20, medium: 40 },
  /** A cycle this large is one severity level worse. */
  largeCycleFiles: 10,
  /** The module view groups files by directory, choosing the deepest level with at most this many modules. */
  maxModules: 30,
} as const;

export interface ArchitectureRuleDefinition {
  id: string;
  /** Short machine-friendly finding type, stored as Finding.type. */
  type: string;
  title: string;
  impact: string;
  recommendation: string;
}

const rule = (r: ArchitectureRuleDefinition) => r;

export const ARCHITECTURE_RULES = {
  cycle: rule({
    id: "architecture/circular-dependency",
    type: "circular-dependency",
    title: "Circular import dependency between files",
    impact:
      "Files in a cycle cannot be understood, tested or reused in isolation, and changes ripple around the loop. In JavaScript and Python, cyclic imports also cause partially initialised modules (undefined exports, ImportError) depending on load order.",
    recommendation:
      "Break the cycle: move the shared code both files need into a new module that depends on neither, invert one dependency with an interface or callback, or merge files that are really one unit.",
  }),
  layerViolation: rule({
    id: "architecture/layer-violation",
    type: "layer-violation",
    title: "Lower layer depends on a higher layer",
    impact:
      "Layering keeps low-level code (utilities, data access) independent of the code that uses it. An upward import couples the layers both ways, which makes the lower layer harder to reuse and test and often leads to cycles.",
    recommendation:
      "Move the needed logic down into the lower layer or a shared module, or pass it in from the caller (dependency injection, callbacks, events) instead of importing upward.",
  }),
  highFanOut: rule({
    id: "architecture/high-fan-out",
    type: "high-fan-out",
    title: "File depends on many other files",
    impact: "A file that imports a large part of the code base is affected by changes in all of them and usually coordinates too many responsibilities.",
    recommendation: "Split the file by responsibility, or introduce a facade module so it depends on a few stable interfaces instead of many concrete files.",
  }),
} as const;

export type ArchitectureRuleKey = keyof typeof ARCHITECTURE_RULES;

/**
 * Conventional layers, highest first. A file's layer is inferred from its
 * file-name suffix (`orders.service.ts`) or the nearest matching directory name.
 */
export const LAYERS = [
  {
    id: "interface",
    label: "Interface (UI / API)",
    dirs: ["components", "pages", "views", "screens", "ui", "layouts", "widgets", "routes", "router", "routers", "controllers", "controller", "handlers", "api", "endpoints", "resolvers", "cli"],
    suffixes: ["controller", "route", "routes", "handler", "resolver", "page", "component", "view"],
  },
  {
    id: "service",
    label: "Services / domain logic",
    dirs: ["services", "service", "usecases", "use-cases", "use_cases", "application", "domain", "business"],
    suffixes: ["service", "usecase"],
  },
  {
    id: "data",
    label: "Data access",
    dirs: ["models", "model", "entities", "entity", "repositories", "repository", "repos", "dao", "daos", "db", "database", "persistence", "migrations"],
    suffixes: ["repository", "repo", "model", "entity", "dao", "schema"],
  },
  {
    id: "shared",
    label: "Shared utilities",
    dirs: ["utils", "util", "helpers", "helper", "common", "shared", "constants"],
    suffixes: ["util", "utils", "helper", "helpers", "constants"],
  },
] as const;

export type LayerId = (typeof LAYERS)[number]["id"];

export function inferLayer(path: string): LayerId | null {
  const segments = path.split("/");
  const file = segments.pop()!;
  // orders.service.ts, user_repository.py, OrderController.java
  const stem = file.replace(/\.[^.]+$/, "");
  const suffix = /[._-]([A-Za-z]+)$/.exec(stem)?.[1]?.toLowerCase() ?? /[a-z]([A-Z][a-z]+)$/.exec(stem)?.[1]?.toLowerCase();
  if (suffix) for (const l of LAYERS) if ((l.suffixes as readonly string[]).includes(suffix)) return l.id;
  for (let i = segments.length - 1; i >= 0; i--) {
    const seg = segments[i]!.toLowerCase();
    for (const l of LAYERS) if ((l.dirs as readonly string[]).includes(seg)) return l.id;
  }
  return null;
}

export const layerRank = (id: LayerId) => LAYERS.findIndex((l) => l.id === id);
export const layerLabel = (id: LayerId) => LAYERS.find((l) => l.id === id)!.label;
