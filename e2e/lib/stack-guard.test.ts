import { describe, expect, it } from "vitest";
import { portOwnersFrom, stackGuardMessage } from "./stack-guard.mjs";

const BASE = "http://localhost:3000";

describe("e2e stack guard", () => {
  it("lets the specs run when the end-to-end web container is running", () => {
    expect(stackGuardMessage({ project: "pd-e2e", webRunning: true, baseUrl: BASE, portOwners: ["pd-e2e"] })).toBeNull();
    // Only the running container decides: two containers cannot publish the same host port.
    expect(stackGuardMessage({ project: "pd-e2e", webRunning: true, baseUrl: BASE })).toBeNull();
  });

  it("refuses when another stack owns the port, naming it and how to stop it", () => {
    // What happened on 2026-10-15: the demo stack held port 3000 and pd-e2e's web stayed "created".
    const message = stackGuardMessage({ project: "pd-e2e", webRunning: false, baseUrl: BASE, portOwners: ["project-doctor"] });
    expect(message).toContain('Refusing to run the end-to-end specs: the "pd-e2e" web container is not running.');
    expect(message).toContain(`${BASE} is served by "project-doctor" instead, so the specs would create users, analyses and model requests there.`);
    expect(message).toContain("docker compose -p project-doctor stop");
    expect(message).toContain("npm run e2e:up");
    expect(message).not.toContain("down");
  });

  it("refuses when nothing serves the port, without suggesting to stop anything", () => {
    const message = stackGuardMessage({ project: "pd-e2e", webRunning: false, baseUrl: BASE, portOwners: [] })!;
    expect(message).toContain('Nothing from "pd-e2e" serves http://localhost:3000.');
    expect(message).not.toContain("docker compose -p");
    // A stopped pd-e2e container listed as the owner is not "another stack".
    expect(stackGuardMessage({ project: "pd-e2e", webRunning: false, baseUrl: BASE, portOwners: ["pd-e2e"] })).toBe(message);
  });

  it("reads the port owners from docker ps output: compose project, else container name", () => {
    expect(portOwnersFrom("project-doctor|project-doctor-web-1\r\n|some-container\n\nproject-doctor|project-doctor-web-1\n")).toEqual(["project-doctor", "some-container"]);
    expect(portOwnersFrom("")).toEqual([]);
  });
});
