// Startup guard for `npm run e2e` (scripts/e2e.mjs). The Playwright specs sign up users and
// start plans and runs against whatever answers on E2E_BASE_URL. That must be the end-to-end
// stack's own web container, whose worker talks only to the model stub: if it is not running
// (for example because another stack already holds port 3000), the specs would reach that
// stack instead, with its database and its real AI provider. Plain JavaScript without
// dependencies, so the script can import it without a build step.

/**
 * The compose projects (or container names, for containers outside compose) that publish the
 * port, from `docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Names}}'`.
 * @param {string} output
 * @returns {string[]}
 */
export function portOwnersFrom(output) {
  const owners = new Set();
  for (const line of String(output).split(/\r?\n/)) {
    const [project = "", name = ""] = line.trim().split("|");
    if (project || name) owners.add(project || name);
  }
  return [...owners];
}

/**
 * Why the specs must not run, or null when they may. Only `webRunning` decides: two containers
 * cannot publish the same host port, so a running end-to-end web container owns it. The port
 * owners only make the message precise.
 * @param {{ project: string; webRunning: boolean; baseUrl: string; portOwners?: string[] }} options
 * @returns {string | null}
 */
export function stackGuardMessage({ project, webRunning, baseUrl, portOwners = [] }) {
  if (webRunning) return null;
  const others = portOwners.filter((o) => o !== project);
  const lines = [
    `Refusing to run the end-to-end specs: the "${project}" web container is not running.`,
    others.length
      ? `${baseUrl} is served by ${others.map((o) => `"${o}"`).join(", ")} instead, so the specs would create users, analyses and model requests there.`
      : `Nothing from "${project}" serves ${baseUrl}.`,
  ];
  if (others.length) lines.push(`Stop that stack first (stop keeps its containers and data), for example: docker compose -p ${others[0]} stop`);
  lines.push("Then start the end-to-end stack with `npm run e2e:up` and run the specs again.");
  return lines.join("\n");
}
