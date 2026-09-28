import { AppError } from "./errors";

export type RepoHost = "github" | "gitlab";

export interface ParsedRepoUrl {
  host: RepoHost;
  owner: string;
  name: string;
  branch?: string;
  /** Canonical https clone URL — never contains credentials. */
  cloneUrl: string;
  webUrl: string;
}

const HOSTS: Record<string, RepoHost> = {
  "github.com": "github",
  "www.github.com": "github",
  "gitlab.com": "gitlab",
  "www.gitlab.com": "gitlab",
};

// GitHub: alphanumerics and single hyphens; GitLab allows dots/underscores too.
const OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/;
const NAME_RE = /^[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^(?!.*\.\.)(?![\/-])(?!.*\/$)[A-Za-z0-9._\/-]{1,200}$/;

/**
 * Parse and strictly validate a public GitHub/GitLab repository URL.
 * Only https URLs on the known hosts are accepted, which also prevents the
 * clone step from being used to reach arbitrary network locations (SSRF).
 */
export function parseRepositoryUrl(input: string): ParsedRepoUrl {
  const raw = input.trim();
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError("VALIDATION_ERROR", "Enter a valid repository URL, e.g. https://github.com/owner/repo");
  }

  if (url.protocol !== "https:") {
    throw new AppError("VALIDATION_ERROR", "Only https:// repository URLs are supported");
  }
  if (url.username || url.password) {
    throw new AppError("VALIDATION_ERROR", "Repository URLs must not contain credentials");
  }
  if (url.port) {
    throw new AppError("VALIDATION_ERROR", "Custom ports are not supported");
  }
  const host = HOSTS[url.hostname.toLowerCase()];
  if (!host) {
    throw new AppError("VALIDATION_ERROR", "Only github.com and gitlab.com repositories are supported");
  }

  const segments = url.pathname.split("/").filter(Boolean).map(decodeURIComponent);
  const [owner, rawName, ...rest] = segments;
  if (!owner || !rawName) {
    throw new AppError("VALIDATION_ERROR", "URL must include both owner and repository name");
  }
  const name = rawName.replace(/\.git$/i, "");
  if (!OWNER_RE.test(owner) || !NAME_RE.test(name) || name === "." || name === "..") {
    throw new AppError("VALIDATION_ERROR", "Repository owner or name contains invalid characters");
  }

  let branch: string | undefined;
  // github.com/o/r/tree/<branch>   gitlab.com/o/r/-/tree/<branch>
  const treeIndex = rest[0] === "-" ? 1 : 0;
  if (rest[treeIndex] === "tree" && rest.length > treeIndex + 1) {
    branch = rest.slice(treeIndex + 1).join("/");
    if (!BRANCH_RE.test(branch)) {
      throw new AppError("VALIDATION_ERROR", "Branch name contains invalid characters");
    }
  } else if (host === "gitlab" && rest.length > 0 && rest[0] !== "-") {
    // GitLab supports nested groups (group/subgroup/repo); keep it simple and explicit.
    throw new AppError("VALIDATION_ERROR", "Nested GitLab groups are not supported yet");
  }

  const canonicalHost = host === "github" ? "github.com" : "gitlab.com";
  const webUrl = `https://${canonicalHost}/${owner}/${name}`;
  return { host, owner, name, branch, cloneUrl: `${webUrl}.git`, webUrl };
}
