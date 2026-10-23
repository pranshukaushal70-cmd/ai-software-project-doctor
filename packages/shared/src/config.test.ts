import { describe, expect, it } from "vitest";
import { loadLimits } from "./config";

describe("loadLimits", () => {
  it("accepts ZIP uploads unless ZIP_UPLOADS_ENABLED turns them off", () => {
    expect(loadLimits({}).zipUploadsEnabled).toBe(true);
    // Empty values fall back to the default, like every other limit.
    expect(loadLimits({ ZIP_UPLOADS_ENABLED: "" }).zipUploadsEnabled).toBe(true);
    expect(loadLimits({ ZIP_UPLOADS_ENABLED: "true" }).zipUploadsEnabled).toBe(true);
    expect(loadLimits({ ZIP_UPLOADS_ENABLED: "false" }).zipUploadsEnabled).toBe(false);
    expect(loadLimits({ ZIP_UPLOADS_ENABLED: "0" }).zipUploadsEnabled).toBe(false);
  });

  it("refuses an unrecognised ZIP_UPLOADS_ENABLED value", () => {
    expect(() => loadLimits({ ZIP_UPLOADS_ENABLED: "no" })).toThrow();
  });
});
