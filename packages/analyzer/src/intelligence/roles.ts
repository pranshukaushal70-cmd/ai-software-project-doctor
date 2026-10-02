import type { FileKind } from "../scanner";

/**
 * What a file is for, derived from its path and the scanner's kind. Finer than
 * `FileKind`: it separates manifests, lockfiles, infrastructure and secret
 * material from other configuration. Purely path-based; contents are not read.
 */
export const FILE_ROLES = [
  "source",
  "test",
  "manifest",
  "lockfile",
  "config",
  "infrastructure",
  "documentation",
  "generated",
  "binary",
  "secret",
  "other",
] as const;
export type FileRole = (typeof FILE_ROLES)[number];

const base = (p: string) => p.slice(p.lastIndexOf("/") + 1);

export const MANIFEST_FILE =
  /^(?:package\.json|requirements[^/]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg|pom\.xml|build\.gradle(?:\.kts)?|settings\.gradle(?:\.kts)?|go\.mod|Cargo\.toml|composer\.json|Gemfile|[\w.-]+\.csproj|deno\.jsonc?)$/;
export const LOCKFILE =
  /^(?:package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|poetry\.lock|uv\.lock|pdm\.lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|Gemfile\.lock|gradle\.lockfile)$/;
const INFRASTRUCTURE_FILE =
  /^(?:Dockerfile(?:\..+)?|[\w.-]+\.dockerfile|\.dockerignore|(?:docker-)?compose(?:\.[\w-]+)?\.ya?ml|Procfile|vercel\.json|netlify\.toml|fly\.toml|render\.yaml|app\.yaml|serverless\.ya?ml|Jenkinsfile|\.gitlab-ci\.yml|azure-pipelines\.yml|\.travis\.yml|bitbucket-pipelines\.yml|skaffold\.yaml|Chart\.yaml|nginx\.conf)$/i;
const INFRASTRUCTURE_PATH = /(?:^|\/)(?:\.github\/workflows|\.circleci|k8s|kubernetes|helm|charts|terraform|infra|deploy|deployment|ansible)\/|\.(?:tf|tfvars|hcl)$/i;
/** Files whose purpose is to hold secrets. Their contents are never read by the intelligence layer. */
const SECRET_FILE = /^(?:\.env(?:\.(?!example$|sample$|template$|dist$|defaults$)[\w.-]+)?|\.npmrc|\.pypirc|\.netrc|id_(?:rsa|dsa|ecdsa|ed25519)|[\w.-]+\.(?:pem|key|p12|pfx|jks|keystore))$/i;

export function fileRole(path: string, kind: FileKind): FileRole {
  const name = base(path);
  if (SECRET_FILE.test(name)) return "secret";
  if (kind === "BINARY") return "binary";
  if (LOCKFILE.test(name)) return "lockfile";
  if (kind === "GENERATED") return "generated";
  if (MANIFEST_FILE.test(name)) return "manifest";
  // Code under deploy/ or infra/ stays source or test; everything else there is infrastructure.
  if (kind === "SOURCE") return "source";
  if (kind === "TEST") return "test";
  if (INFRASTRUCTURE_FILE.test(name) || INFRASTRUCTURE_PATH.test(path)) return "infrastructure";
  switch (kind) {
    case "DOCUMENTATION":
      return "documentation";
    case "CONFIG":
      return "config";
    default:
      return "other";
  }
}
