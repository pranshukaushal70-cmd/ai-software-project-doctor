import { snippet } from "../metrics/evidence";
import { PRACTICE_THRESHOLDS } from "./rules";
import { basename, lineIndex, type RawPracticeFinding, type TextFile } from "./types";

/**
 * HTTP API analysis: finds the endpoints a repository declares (Express-style
 * routers, Fastify, Koa, Hono, NestJS, Next.js route handlers, Flask, FastAPI,
 * Django, Spring) by matching their declaration syntax, then checks each one and
 * the API set-up for common weaknesses. Nothing is executed; a route declared
 * dynamically (computed paths, loops) is not seen.
 */

export interface ApiEndpoint {
  method: string;
  path: string;
  file: string;
  line: number;
  framework: string;
  /** An authentication marker is visible for this route (route, file or application level). */
  auth: boolean;
  readsBody: boolean;
  validated: boolean;
}

export interface ApiSummary {
  endpoints: number;
  byMethod: Record<string, number>;
  frameworks: Array<{ name: string; endpoints: number }>;
  /** Endpoints ordered by path; at most MAX_LISTED. */
  list: ApiEndpoint[];
  listTruncated: boolean;
  /** POST, PUT, PATCH and DELETE endpoints. */
  mutating: number;
  mutatingWithoutAuth: number;
  bodyWithoutValidation: number;
  /** Where authentication is applied to every route, when detected ("path: what"). */
  globalAuth: string | null;
  /** Where rate limiting is configured, when detected. */
  rateLimiting: string | null;
  specFiles: string[];
  /** Library or framework that generates an API specification, when detected. */
  specTooling: string | null;
}

const MAX_LISTED = 300;
const WINDOW_LINES = 60;
const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
/** Frameworks whose routes are declared by decorators/annotations stacked above the handler. */
const DECORATOR_FRAMEWORKS = new Set(["NestJS", "Flask", "FastAPI", "Python", "Spring"]);
const HTTP_METHODS = "GET|HEAD|POST|PUT|PATCH|DELETE|OPTIONS";

const JS_LANGS = new Set(["javascript", "typescript"]);

// ---------------------------------------------------------------- markers

/** `auth(?!or)` keeps "author" from counting as authentication. */
const AUTH_MARKER =
  /auth(?!or)|session|jwt|passport|guard|permission|login_required|current_?user|require\w*user|verify_?token|@PreAuthorize|@Secured|@RolesAllowed|getServerSession|clerk/i;
const BODY_MARKER = /\breq(?:uest)?\.body\b|\b(?:req|request)\.json\s*\(|request\.get_json\s*\(|request\.(?:form|data|POST)\b|@RequestBody\b|ctx\.request\.body/;
const VALIDATION_MARKER =
  /\bz\.\w+|\.(?:safe)?[pP]arse(?:Async)?\s*\(|\bJoi\b|\byup\b|celebrate|express-validator|validationResult|class-validator|@Valid\b|@Validated\b|\bajv\b|\bvalidate\w*\s*\(|\bvalibot\b|typebox|superstruct|pydantic|BaseModel|Serializer\b|\.is_valid\s*\(|marshmallow|wtforms/;
const RATE_LIMIT_MARKER = /rate[-_ ]?limit|ratelimit|throttl|slowapi|bucket4j|express-slow-down|\blimiter\b|brute/i;
/** Routes that are public by design (sign-in, webhooks, health checks …). */
const PUBLIC_PATH =
  /(?:^|\/)(?:login|log-in|signin|sign-in|signup|sign-up|register|logout|sign-out|auth|oauth\d?|callback|webhooks?|health|healthz|ready|readyz|live|ping|status|public|forgot[\w-]*|reset[\w-]*|verify[\w-]*|token|refresh|csp-report|graphql)(?:\/|$|[?:{[(])/i;
const LOGIN_PATH = /(?:^|\/)(?:login|log-in|signin|sign-in|sessions?|token|authenticate)(?:\/|$)/i;

/** Application-wide authentication: middleware, global guards, security configuration. */
const GLOBAL_AUTH: Array<{ re: RegExp; what: string; path?: RegExp }> = [
  { re: AUTH_MARKER, what: "Next.js middleware", path: /^(?:src\/)?(?:middleware|proxy)\.[cm]?[jt]s$/ },
  { re: /@EnableWebSecurity|SecurityFilterChain|WebSecurityConfigurerAdapter/, what: "Spring Security configuration" },
  { re: /APP_GUARD|useGlobalGuards\s*\(/, what: "global NestJS guard" },
  { re: /DEFAULT_PERMISSION_CLASSES[\s\S]{0,200}?IsAuthenticated|LoginRequiredMiddleware/, what: "Django settings" },
  { re: /FastAPI\s*\([^)]*dependencies\s*=/, what: "FastAPI application dependencies" },
  { re: /\bapp\.use\s*\(\s*(?!['"`])[^\n]*(?:auth(?!or)|session|jwt|passport|require\w*user|isAuthenticated)/i, what: "application-wide middleware" },
];

/** Authentication applied to every route of one file (router middleware, class-level guards …). */
const FILE_AUTH = [
  /\.use\s*\([^\n]*(?:auth(?!or)|session|jwt|passport|guard|require\w*user|isAuthenticated)/i,
  /@UseGuards\b/,
  /before_request[\s\S]{0,400}?(?:auth|login|session|current_user|token)/i,
  /APIRouter\s*\([^)]*dependencies\s*=/,
];

const SPEC_FILE = /(?:^|\/)(?:openapi|swagger)[\w.-]*\.(?:json|ya?ml)$/i;
const SPEC_TOOLING = /swagger|openapi|springdoc|drf-spectacular|drf-yasg|flasgger|\btsoa\b|apispec/i;
const API_DOC = /(?:^|\/)(?:docs?\/)?api[\w-]*\.(?:md|mdx|rst|adoc)$|(?:^|\/)docs?\/api\//i;

// ---------------------------------------------------------------- endpoint detection

interface Match {
  method: string;
  path: string;
  index: number;
  framework: string;
}

const JS_ROUTE = /\b([A-Za-z_$][\w$]*)\s*\.\s*(get|post|put|patch|delete|del|all|options|head)\s*\(\s*(['"`])(\/[^'"`\n]*)\3/g;
const JS_CHAIN = /\.route\s*\(\s*(['"`])(\/[^'"`\n]*)\1\s*\)/g;
const JS_SERVER_IMPORT = /(?:from\s+|require\(\s*)['"](express|fastify|koa|@koa\/router|koa-router|hono|restify|@hapi\/hapi|polka|h3|elysia)['"]/;
const JS_CLIENT_IMPORT = /(?:from\s+|require\(\s*)['"](axios|ky|got|superagent|supertest|node-fetch|undici)['"]/;
const JS_SERVER_OBJECT = /^(?:app|server|fastify|\w*[Rr]outer|routes?)$/;
/** Objects whose `.get("/…")` is a client call, a map lookup or a response, not a route. */
const JS_CLIENT_OBJECT =
  /^(?:axios|https?|client|request|superagent|got|ky|fetcher|instance|\$http|httpClient|apiClient|supertest|agent|cy|page|map|cache|params|headers|searchParams|url|store|storage|localStorage|sessionStorage|redis|res|response)$/i;
const NEXT_APP_ROUTE = /(?:^|\/)app\/((?:[^/]+\/)*)route\.[cm]?[jt]sx?$/;
const NEXT_PAGES_API = /(?:^|\/)pages\/(api(?:\/[^.]+?)?)(?:\/index)?\.[cm]?[jt]sx?$/;
const NEXT_METHOD = new RegExp(
  `export\\s+(?:async\\s+)?function\\s+(${HTTP_METHODS})\\b|export\\s+const\\s+(${HTTP_METHODS})\\b|\\bas\\s+(${HTTP_METHODS})\\b`,
  "g",
);
const NEST_CONTROLLER = /@Controller\(\s*(?:['"`]([^'"`]*)['"`])?/;
const NEST_ROUTE = /@(Get|Post|Put|Patch|Delete|All|Options|Head)\(\s*(?:['"`]([^'"`]*)['"`])?[^)]*\)/g;
const PY_ROUTE = /@([A-Za-z_][\w.]*)\.(route|get|post|put|patch|delete|api_route)\(\s*(?:path\s*=\s*)?[rf]?(['"])([^'"\n]*)\3([^\n]*)/g;
const DJANGO_PATH = /\b(?:re_)?path\(\s*r?(['"])([^'"\n]*)\1([^\n]*)/g;
const DRF_REGISTER = /\.register\(\s*r?(['"])([^'"\n]*)\1/g;
const SPRING_ROUTE = /@(Get|Post|Put|Patch|Delete|Request)Mapping\b(?:\s*\(([^)]*)\))?/g;

const joinPath = (...parts: string[]) => {
  const joined = parts
    .map((p) => p.replace(/^\/+|\/+$/g, ""))
    .filter(Boolean)
    .join("/");
  return `/${joined}`;
};

function detectJs(file: TextFile): Match[] {
  const text = file.text;
  const out: Match[] = [];
  const next = NEXT_APP_ROUTE.exec(file.path);
  if (next) {
    const segments = next[1]!.split("/").filter((s) => s && !/^\(.*\)$/.test(s) && !s.startsWith("@"));
    for (const m of text.matchAll(NEXT_METHOD)) out.push({ method: (m[1] ?? m[2] ?? m[3])!, path: joinPath(...segments), index: m.index, framework: "Next.js" });
    return out;
  }
  const pagesApi = NEXT_PAGES_API.exec(file.path);
  if (pagesApi) {
    const at = text.search(/export\s+default/);
    return at >= 0 ? [{ method: "ANY", path: joinPath(pagesApi[1]!), index: at, framework: "Next.js" }] : [];
  }
  if (/from\s+['"]@nestjs\/common['"]/.test(text)) {
    const prefix = NEST_CONTROLLER.exec(text)?.[1] ?? "";
    for (const m of text.matchAll(NEST_ROUTE)) {
      const method = m[1]!.toUpperCase();
      out.push({ method: method === "ALL" ? "ANY" : method, path: joinPath(prefix, m[2] ?? ""), index: m.index, framework: "NestJS" });
    }
    return out;
  }
  const serverImport = JS_SERVER_IMPORT.exec(text)?.[1];
  const clientImport = JS_CLIENT_IMPORT.test(text);
  const framework = serverImport ? frameworkName(serverImport) : "Node.js";
  const isRoute = (obj: string) => (JS_SERVER_OBJECT.test(obj) && (!!serverImport || !clientImport)) || (!!serverImport && !JS_CLIENT_OBJECT.test(obj));
  for (const m of text.matchAll(JS_ROUTE)) {
    if (!isRoute(m[1]!)) continue;
    const verb = m[2]!.toUpperCase();
    out.push({ method: verb === "DEL" ? "DELETE" : verb === "ALL" ? "ANY" : verb, path: m[4]!, index: m.index, framework });
  }
  if (serverImport) {
    for (const m of text.matchAll(JS_CHAIN)) {
      const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 2000);
      const end = tail.search(/;|\.route\s*\(/);
      for (const v of (end >= 0 ? tail.slice(0, end) : tail).matchAll(/\.\s*(get|post|put|patch|delete|all)\s*\(/g)) {
        const verb = v[1]!.toUpperCase();
        out.push({ method: verb === "ALL" ? "ANY" : verb, path: m[2]!, index: m.index, framework });
      }
    }
  }
  return out;
}

function frameworkName(module: string): string {
  if (module === "express") return "Express";
  if (module === "fastify") return "Fastify";
  if (module.includes("koa")) return "Koa";
  if (module === "hono") return "Hono";
  if (module === "@hapi/hapi") return "hapi";
  return module;
}

function detectPython(file: TextFile): Match[] {
  const text = file.text;
  const out: Match[] = [];
  const framework = /^\s*(?:from|import)\s+fastapi\b/m.test(text) ? "FastAPI" : /^\s*(?:from|import)\s+flask\b/m.test(text) ? "Flask" : "Python";
  for (const m of text.matchAll(PY_ROUTE)) {
    const path = m[4]!;
    if (path && !path.startsWith("/")) continue;
    const verb = m[2]!;
    if (verb === "route" || verb === "api_route") {
      const methods = /methods\s*=\s*[[(]([^\])]*)[\])]/.exec(m[5]!)?.[1];
      const list = methods ? [...methods.matchAll(/['"](\w+)['"]/g)].map((x) => x[1]!.toUpperCase()) : ["GET"];
      for (const method of list) out.push({ method, path: path || "/", index: m.index, framework });
    } else out.push({ method: verb.toUpperCase(), path: path || "/", index: m.index, framework });
  }
  if (basename(file.path) === "urls.py") {
    for (const m of text.matchAll(DJANGO_PATH)) {
      if (/\binclude\s*\(/.test(m[3]!)) continue;
      out.push({ method: "ANY", path: joinPath(m[2]!.replace(/^\^|\$$/g, "")), index: m.index, framework: "Django" });
    }
    for (const m of text.matchAll(DRF_REGISTER)) out.push({ method: "ANY", path: joinPath(m[2]!), index: m.index, framework: "Django REST framework" });
  }
  return out;
}

function detectJava(file: TextFile): Match[] {
  const text = file.text;
  if (!/@(?:Rest)?Controller\b/.test(text)) return [];
  const classAt = text.search(/\bclass\s+\w+/);
  const out: Match[] = [];
  let prefix = "";
  for (const m of text.matchAll(SPRING_ROUTE)) {
    const args = m[2] ?? "";
    const path = /"([^"]*)"/.exec(args)?.[1] ?? "";
    if (classAt >= 0 && m.index < classAt) {
      if (m[1] === "Request") prefix = path;
      continue;
    }
    const method = m[1] === "Request" ? (/RequestMethod\.(\w+)/.exec(args)?.[1] ?? "ANY") : m[1]!.toUpperCase();
    out.push({ method, path: joinPath(prefix, path), index: m.index, framework: "Spring" });
  }
  return out;
}

// ---------------------------------------------------------------- set-up checks

interface CorsRule {
  re: RegExp;
  /** `reflect`: any origin is echoed back. `wildcard`: `*`, which browsers refuse with credentials. */
  kind: "reflect" | "wildcard";
  /** Frameworks that turn a wildcard into a reflected origin when credentials are allowed. */
  reflectsWithCredentials?: boolean;
}

const CORS_RULES: Record<string, { rules: CorsRule[]; credentials: RegExp }> = {
  js: {
    rules: [
      { re: /\bcors\(\s*\)/, kind: "wildcard" },
      { re: /\borigin\s*:\s*(['"`])\*\1/, kind: "wildcard" },
      { re: /\borigin\s*:\s*true\b/, kind: "reflect" },
      { re: /Access-Control-Allow-Origin['"`]\s*,\s*(['"`])\*\1/, kind: "wildcard" },
      { re: /Access-Control-Allow-Origin['"`]\s*,\s*(?:req|request)\.headers?(?:\.origin|\[['"`]origin['"`]\])/i, kind: "reflect" },
    ],
    credentials: /credentials\s*:\s*true|Access-Control-Allow-Credentials['"`]\s*,\s*['"`]?true/,
  },
  python: {
    rules: [
      { re: /\bCORS\(\s*\w+\s*\)/, kind: "wildcard", reflectsWithCredentials: true },
      { re: /allow_origins\s*=\s*\[\s*['"]\*['"]\s*\]/, kind: "wildcard", reflectsWithCredentials: true },
      { re: /CORS_(?:ALLOW_ALL_ORIGINS|ORIGIN_ALLOW_ALL)\s*=\s*True/, kind: "wildcard", reflectsWithCredentials: true },
      { re: /\borigins\s*=\s*['"]\*['"]/, kind: "wildcard", reflectsWithCredentials: true },
    ],
    credentials: /allow_credentials\s*=\s*True|CORS_ALLOW_CREDENTIALS\s*=\s*True|supports_credentials\s*=\s*True/,
  },
  java: {
    rules: [
      // `@CrossOrigin` or `@CrossOrigin("*")`; an explicit origin such as `@CrossOrigin("https://app.example")` is fine.
      { re: /@CrossOrigin\b(?!\s*\(\s*(?:(?:origins|value|originPatterns)\s*=\s*)?\{?\s*"(?!\*))/, kind: "wildcard" },
      { re: /allowedOrigins\s*\(\s*"\*"\s*\)/, kind: "wildcard" },
      { re: /allowedOriginPatterns\s*\(\s*"\*"\s*\)/, kind: "wildcard", reflectsWithCredentials: true },
    ],
    credentials: /allowCredentials\s*\(\s*true\s*\)|allowCredentials\s*=\s*"true"/,
  },
};

const ERROR_EXPOSURE: Record<string, RegExp[]> = {
  js: [/\b(?:res|response|reply|ctx)\b[^\n]*\b(?:err|error|e|ex|exception)\.stack\b/, /\bstack\s*:\s*(?:err|error|e|ex)\.stack\b/],
  python: [/\b(?:return|jsonify|Response|HttpResponse|JSONResponse)\b[^\n]*traceback\.format_exc\(\)/],
  java: [/printStackTrace\s*\(\s*\w+\.getWriter\(\)/, /ResponseEntity[^\n]*getStackTrace\(\)/],
};

const langGroup = (language: string | null) => (language && JS_LANGS.has(language) ? "js" : language === "python" ? "python" : language === "java" ? "java" : null);

export function analyzeApi(files: readonly TextFile[], allPaths: readonly string[], manifests: readonly TextFile[]): { raw: RawPracticeFinding[]; summary: ApiSummary } {
  const raw: RawPracticeFinding[] = [];
  const endpoints: ApiEndpoint[] = [];
  const source = files.filter((f) => f.kind === "SOURCE" && langGroup(f.language));

  let globalAuth: string | null = null;
  for (const f of source) {
    for (const g of GLOBAL_AUTH) {
      if (g.path && !g.path.test(f.path)) continue;
      if (g.re.test(f.text)) {
        globalAuth = `${f.path}: ${g.what}`;
        break;
      }
    }
    if (globalAuth) break;
  }
  const rateLimitFile = [...source, ...manifests].find((f) => RATE_LIMIT_MARKER.test(f.text));

  for (const f of source) {
    const group = langGroup(f.language)!;
    const at = lineIndex(f.text);
    const lines = f.text.split("\n");

    // Endpoints and their per-route checks.
    const matches = (group === "js" ? detectJs(f) : group === "python" ? detectPython(f) : detectJava(f)).sort((a, b) => a.index - b.index);
    const fileAuth = FILE_AUTH.some((re) => re.test(f.text));
    const fileValidates = VALIDATION_MARKER.test(f.text);
    const seen = new Set<string>();
    matches.forEach((m, i) => {
      const id = `${m.method} ${m.path}`;
      if (seen.has(id)) return;
      seen.add(id);
      const line = at(m.index);
      // The route's own text, up to the next route. Decorator-based frameworks also get the
      // few lines above the declaration (stacked decorators such as @PreAuthorize), but never
      // the previous route's declaration line.
      const prevLine = i > 0 ? at(matches[i - 1]!.index) : 0;
      const lookBack = DECORATOR_FRAMEWORKS.has(m.framework) ? 3 : 0;
      const start = Math.max(prevLine, line - 1 - lookBack);
      const end = i + 1 < matches.length && matches[i + 1]!.index > m.index ? at(matches[i + 1]!.index) - 1 : line + WINDOW_LINES;
      const window = lines.slice(start, Math.min(lines.length, end, line + WINDOW_LINES)).join("\n");
      const readsBody = BODY_MARKER.test(window);
      endpoints.push({
        method: m.method,
        path: m.path,
        file: f.path,
        line,
        framework: m.framework,
        auth: !!globalAuth || fileAuth || AUTH_MARKER.test(window),
        readsBody,
        validated: fileValidates || VALIDATION_MARKER.test(window),
      });
    });

    // CORS configuration.
    const cors = CORS_RULES[group]!;
    const credentials = cors.credentials.test(f.text);
    for (const rule of cors.rules) {
      const m = rule.re.exec(f.text);
      if (!m) continue;
      const line = at(m.index);
      const reflects = rule.kind === "reflect" || (credentials && !!rule.reflectsWithCredentials);
      const severity = reflects && credentials ? "HIGH" : "LOW";
      raw.push({
        rule: "permissiveCors",
        path: f.path,
        severity,
        line,
        evidence:
          `\`${snippet(lines[line - 1] ?? "")}\`: ` +
          (reflects
            ? credentials
              ? "every origin is echoed back and credentials are allowed, so any website can make authenticated requests and read the responses."
              : "every origin is echoed back. Credentials are not enabled here, so the risk is limited to unauthenticated data."
            : "any origin may call the API." + (credentials ? " Browsers refuse `*` together with credentials, so authenticated cross-origin calls fail instead." : "")),
        key: `cors:${snippet(lines[line - 1] ?? "")}`,
        data: { kind: rule.kind, credentials, cwe: "CWE-942" },
      });
    }

    // Internal error details sent to clients.
    const exposure = ERROR_EXPOSURE[group]!;
    lines.forEach((text, idx) => {
      if (!exposure.some((re) => re.test(text)) || /console\.|logger\.|log\.|print\(/.test(text)) return;
      raw.push({
        rule: "errorDetailsExposed",
        path: f.path,
        severity: "MEDIUM",
        line: idx + 1,
        evidence: `\`${snippet(text)}\` sends the error's stack trace in the response.`,
        key: `stack:${snippet(text)}`,
        data: { cwe: "CWE-209" },
      });
    });
  }

  endpoints.sort((a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method) || a.file.localeCompare(b.file));

  for (const e of endpoints) {
    if (MUTATING.has(e.method) && !e.auth && !PUBLIC_PATH.test(e.path)) {
      raw.push({
        rule: "unauthenticatedMutation",
        path: e.file,
        severity: "LOW",
        line: e.line,
        evidence: `\`${e.method} ${e.path}\` (${e.framework}): no authentication middleware, guard, decorator or user check is visible in the route, in its file or in the application set-up.`,
        key: `${e.method} ${e.path}`,
        data: { method: e.method, route: e.path, framework: e.framework, heuristic: true, cwe: "CWE-306" },
      });
    }
    if (e.readsBody && !e.validated) {
      raw.push({
        rule: "missingInputValidation",
        path: e.file,
        severity: "LOW",
        line: e.line,
        evidence: `\`${e.method} ${e.path}\` reads the request body, and no schema validation (zod, Joi, Pydantic, Bean Validation, …) is visible in the route or its file.`,
        key: `${e.method} ${e.path}`,
        data: { method: e.method, route: e.path, framework: e.framework, cwe: "CWE-20" },
      });
    }
  }

  const login = endpoints.find((e) => (e.method === "POST" || e.method === "ANY") && LOGIN_PATH.test(e.path));
  if (login && !rateLimitFile) {
    raw.push({
      rule: "authWithoutRateLimit",
      path: login.file,
      severity: "LOW",
      line: login.line,
      evidence: `\`${login.method} ${login.path}\` accepts credentials, and no rate-limiting library or configuration was found in the source or the dependency manifests.`,
      key: "login",
      data: { route: login.path, cwe: "CWE-307" },
    });
  }

  const specFiles = allPaths.filter((p) => SPEC_FILE.test(p));
  const toolingSource = [...manifests, ...source].find((f) => SPEC_TOOLING.test(f.text));
  const specTooling = endpoints.some((e) => e.framework === "FastAPI")
    ? "FastAPI (generated at /docs)"
    : toolingSource
      ? `${toolingSource.path}: ${SPEC_TOOLING.exec(toolingSource.text)![0]}`
      : null;
  const apiDoc = allPaths.find((p) => API_DOC.test(p));
  if (endpoints.length >= PRACTICE_THRESHOLDS.apiSpecEndpoints && specFiles.length === 0 && !specTooling && !apiDoc) {
    raw.push({
      rule: "noApiSpec",
      path: "",
      severity: "LOW",
      line: null,
      evidence: `${endpoints.length} HTTP endpoints were found, but no OpenAPI/Swagger document, no specification generator and no API documentation file (such as docs/api.md).`,
      key: "api-spec",
      data: { endpoints: endpoints.length },
    });
  }

  const byMethod: Record<string, number> = {};
  const byFramework = new Map<string, number>();
  for (const e of endpoints) {
    byMethod[e.method] = (byMethod[e.method] ?? 0) + 1;
    byFramework.set(e.framework, (byFramework.get(e.framework) ?? 0) + 1);
  }
  const mutating = endpoints.filter((e) => MUTATING.has(e.method));
  return {
    raw,
    summary: {
      endpoints: endpoints.length,
      byMethod,
      frameworks: [...byFramework].map(([name, n]) => ({ name, endpoints: n })).sort((a, b) => b.endpoints - a.endpoints),
      list: endpoints.slice(0, MAX_LISTED),
      listTruncated: endpoints.length > MAX_LISTED,
      mutating: mutating.length,
      mutatingWithoutAuth: mutating.filter((e) => !e.auth && !PUBLIC_PATH.test(e.path)).length,
      bodyWithoutValidation: endpoints.filter((e) => e.readsBody && !e.validated).length,
      globalAuth,
      rateLimiting: rateLimitFile ? `${rateLimitFile.path}: ${RATE_LIMIT_MARKER.exec(rateLimitFile.text)![0]}` : null,
      specFiles,
      specTooling,
    },
  };
}
