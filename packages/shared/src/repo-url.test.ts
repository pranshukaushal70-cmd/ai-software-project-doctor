import { describe, expect, it } from "vitest";
import { parseRepositoryUrl } from "./repo-url";

describe("parseRepositoryUrl", () => {
  it("parses a plain GitHub URL", () => {
    expect(parseRepositoryUrl("https://github.com/vercel/next.js")).toEqual({
      host: "github",
      owner: "vercel",
      name: "next.js",
      branch: undefined,
      cloneUrl: "https://github.com/vercel/next.js.git",
      webUrl: "https://github.com/vercel/next.js",
    });
  });

  it("strips .git suffix and trailing slash", () => {
    const parsed = parseRepositoryUrl("  https://github.com/owner/repo.git/ ");
    expect(parsed.name).toBe("repo");
    expect(parsed.cloneUrl).toBe("https://github.com/owner/repo.git");
  });

  it("extracts a branch from /tree/<branch>", () => {
    expect(parseRepositoryUrl("https://github.com/o/r/tree/feature/login").branch).toBe("feature/login");
  });

  it("supports GitLab URLs including /-/tree/<branch>", () => {
    const parsed = parseRepositoryUrl("https://gitlab.com/group/project/-/tree/main");
    expect(parsed).toMatchObject({ host: "gitlab", owner: "group", name: "project", branch: "main" });
  });

  it.each([
    ["not a url", "valid repository URL"],
    ["http://github.com/o/r", "https://"],
    ["ssh://git@github.com/o/r", "https://"],
    ["https://user:pass@github.com/o/r", "credentials"],
    ["https://github.com:8443/o/r", "ports"],
    ["https://evil.example.com/o/r", "github.com and gitlab.com"],
    ["https://169.254.169.254/latest/meta-data", "github.com and gitlab.com"],
    ["https://github.com/onlyowner", "owner and repository"],
    ["https://github.com/o/r%20x", "invalid characters"],
    ["https://github.com/o/r/tree/..%2Fetc", "invalid characters"],
    // A leading dash could be interpreted by git as a command-line option.
    ["https://github.com/o/r/tree/--upload-pack", "invalid characters"],
  ])("rejects %s", (input, message) => {
    expect(() => parseRepositoryUrl(input)).toThrow(message);
  });
});
