import type { DependencyRecord, ParsedManifest } from "./types";

/** Exact Maven/Gradle version: no ranges, dynamic markers or unresolved properties. */
export function exactJvmVersion(spec: string | null): string | null {
  if (!spec) return null;
  const s = spec.trim();
  if (!s || /[[\]()$,+*]/.test(s) || /^(LATEST|RELEASE|latest\.\w+)$/i.test(s)) return null;
  return s;
}

const lineAt = (text: string, index: number) => {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
  return n;
};

/** Replace an XML region with spaces, keeping offsets (and therefore line numbers) intact. */
const blank = (text: string, re: RegExp) => text.replace(re, (m) => m.replace(/[^\n]/g, " "));

const tag = (block: string, name: string) => new RegExp(`<${name}>\\s*([^<]*?)\\s*</${name}>`).exec(block)?.[1] ?? null;

/**
 * pom.xml: `<dependencies>` of the project (not of plugins), with `${property}`
 * versions resolved from `<properties>` and versions taken from
 * `<dependencyManagement>` when omitted. Parent POMs are not fetched.
 */
export function parsePom(path: string, text: string): ParsedManifest {
  const noComments = blank(text, /<!--[\s\S]*?-->/g);
  const props = new Map<string, string>();
  const propsBlock = /<properties>([\s\S]*?)<\/properties>/.exec(noComments)?.[1] ?? "";
  for (const m of propsBlock.matchAll(/<([\w.-]+)>\s*([^<]*?)\s*<\/\1>/g)) props.set(m[1]!, m[2]!);
  const projectBody = blank(noComments, /<parent>[\s\S]*?<\/parent>/g);
  const projectVersion = tag(blank(projectBody, /<(dependencies|dependencyManagement|build|profiles|properties)>[\s\S]*?<\/\1>/g), "version");
  if (projectVersion) props.set("project.version", projectVersion);
  const parentVersion = /<parent>[\s\S]*?<version>\s*([^<]*?)\s*<\/version>/.exec(noComments)?.[1];
  if (parentVersion) {
    props.set("project.parent.version", parentVersion);
    if (!projectVersion) props.set("project.version", parentVersion);
  }
  const resolve = (v: string | null): string | null => {
    if (!v) return null;
    let out = v;
    for (let i = 0; i < 5 && /\$\{[^}]+\}/.test(out); i++) out = out.replace(/\$\{([^}]+)\}/g, (m, k: string) => props.get(k) ?? m);
    return out;
  };

  const managed = new Map<string, string>();
  const mgmt = /<dependencyManagement>([\s\S]*?)<\/dependencyManagement>/.exec(noComments)?.[1] ?? "";
  for (const m of mgmt.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const g = tag(m[1]!, "groupId");
    const a = tag(m[1]!, "artifactId");
    const v = resolve(tag(m[1]!, "version"));
    if (g && a && v) managed.set(`${g}:${a}`, v);
  }

  // Only the project's own dependencies: drop build plugins and dependencyManagement (same offsets, so lines stay right).
  const body = blank(noComments, /<(build|dependencyManagement|reporting)>[\s\S]*?<\/\1>/g);
  const deps: DependencyRecord[] = [];
  for (const m of body.matchAll(/<dependency>([\s\S]*?)<\/dependency>/g)) {
    const block = m[1]!;
    const g = resolve(tag(block, "groupId"));
    const a = resolve(tag(block, "artifactId"));
    if (!g || !a) continue;
    const name = `${g}:${a}`;
    const declared = tag(block, "version");
    const version = resolve(declared) ?? managed.get(name) ?? null;
    const scope = tag(block, "scope");
    if (scope === "import" || scope === "system") continue;
    deps.push({
      ecosystem: "Maven",
      name,
      versionSpec: declared ?? version,
      resolvedVersion: exactJvmVersion(version),
      direct: true,
      dev: scope === "test",
      manifestPath: path,
      line: lineAt(noComments, m.index),
      source: "registry",
      publicRegistry: true,
    });
  }
  return { path, ecosystem: "Maven", kind: "manifest", dependencies: deps };
}

const GRADLE_CONFIG =
  /\b(implementation|api|compile|compileOnly|runtimeOnly|runtime|annotationProcessor|kapt|ksp|testImplementation|testCompile|testCompileOnly|testRuntimeOnly|androidTestImplementation|testFixturesImplementation|debugImplementation|releaseImplementation)\b\s*\(?\s*(?:platform\s*\(\s*)?["']([^"'\s:]+):([^"'\s:]+):([^"'\s@]+)(?:@\w+)?["']/g;

/** build.gradle / build.gradle.kts: string-notation dependencies (`"group:artifact:version"`). */
export function parseGradle(path: string, text: string): ParsedManifest {
  const vars = new Map<string, string>();
  for (const m of text.matchAll(/\b(?:def|val|var|ext\.)\s*(\w+)\s*=\s*["']([^"'$]+)["']/g)) vars.set(m[1]!, m[2]!);
  const noComments = blank(blank(text, /\/\*[\s\S]*?\*\//g), /\/\/[^\n]*/g);
  const deps: DependencyRecord[] = [];
  for (const m of noComments.matchAll(GRADLE_CONFIG)) {
    const config = m[1]!;
    let version = m[4]!;
    const ref = /^\$\{?(\w+)\}?$/.exec(version);
    if (ref && vars.has(ref[1]!)) version = vars.get(ref[1]!)!;
    deps.push({
      ecosystem: "Maven",
      name: `${m[2]}:${m[3]}`,
      versionSpec: m[4]!,
      resolvedVersion: exactJvmVersion(version),
      direct: true,
      dev: /^(test|androidTest|testFixtures|debug)/.test(config),
      manifestPath: path,
      line: lineAt(noComments, m.index),
      source: "registry",
      publicRegistry: true,
    });
  }
  return { path, ecosystem: "Maven", kind: "manifest", dependencies: deps };
}
