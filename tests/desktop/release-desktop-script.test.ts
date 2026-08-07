import { describe, expect, it } from "vitest";
import {
  assertReleaseBranch,
  parseArguments,
  parseSemver,
  resolveVersion,
} from "../../scripts/release-desktop.mjs";

describe("desktop release command", () => {
  it("defaults to a checked patch release that waits for publication", () => {
    expect(parseArguments([])).toEqual({
      version: "patch",
      skipChecks: false,
      wait: true,
    });
  });

  it("accepts an explicit version for interrupted release retries", () => {
    expect(resolveVersion("0.3.22", "0.3.22")).toBe("0.3.22");
    expect(resolveVersion("0.3.21", "0.3.22")).toBe("0.3.22");
  });

  it("rejects invalid or decreasing versions", () => {
    expect(() => parseSemver("0.3")).toThrow("Invalid desktop version");
    expect(() => resolveVersion("0.3.22", "0.3.21")).toThrow(
      "cannot decrease",
    );
  });

  it("keeps the divergent local main branch out of production releases", () => {
    expect(() => assertReleaseBranch("main")).toThrow(
      "Local main is intentionally not used",
    );
    expect(() =>
      assertReleaseBranch("fix/image-generation-and-config-sync"),
    ).not.toThrow();
  });
});
