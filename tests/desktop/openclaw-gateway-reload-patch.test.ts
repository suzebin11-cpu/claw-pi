import { isDeepStrictEqual } from "node:util";
import { describe, expect, it } from "vitest";
import {
  CLAWPI_XAI_RELOAD_NORMALIZATION_MARKER,
  patchOpenClawGatewayReloadSource,
} from "../../apps/desktop/scripts/lib/openclaw-gateway-reload-patch.mjs";

const ORIGINAL_DIFF_SOURCE = `
function diffConfigPaths(prev, next, prefix = "") {
\tif (prev === next) return [];
\tif (isPlainObject(prev) && isPlainObject(next)) {
\t\tconst keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
\t\tconst paths = [];
\t\tfor (const key of keys) {
\t\t\tconst prevValue = prev[key];
\t\t\tconst nextValue = next[key];
\t\t\tif (prevValue === void 0 && nextValue === void 0) continue;
\t\t\tconst childPaths = diffConfigPaths(prevValue, nextValue, prefix ? \`\${prefix}.\${key}\` : key);
\t\t\tif (childPaths.length > 0) paths.push(...childPaths);
\t\t}
\t\treturn paths;
\t}
\tif (Array.isArray(prev) && Array.isArray(next)) {
\t\tif (isDeepStrictEqual(prev, next)) return [];
\t}
\treturn [prefix || "<root>"];
}
`;

function buildDiffConfigPaths() {
  const { source } = patchOpenClawGatewayReloadSource(
    ORIGINAL_DIFF_SOURCE,
    "test bundle",
  );
  const isPlainObject = (value: unknown) =>
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype;
  return new Function(
    "isPlainObject",
    "isDeepStrictEqual",
    `${source}; return diffConfigPaths;`,
  )(isPlainObject, isDeepStrictEqual) as (
    previous: unknown,
    next: unknown,
  ) => string[];
}

describe("OpenClaw Gateway reload compatibility patch", () => {
  it("treats only the implicit empty xAI webSearch default as equivalent", () => {
    const diffConfigPaths = buildDiffConfigPaths();

    expect(
      diffConfigPaths(
        { plugins: { entries: { xai: { config: { webSearch: {} } } } } },
        { plugins: { entries: { xai: { config: {} } } } },
      ),
    ).toEqual([]);
    expect(
      diffConfigPaths(
        { plugins: { entries: { xai: { config: { webSearch: {} } } } } },
        {
          plugins: {
            entries: {
              xai: { config: { webSearch: { apiKey: "changed" } } },
            },
          },
        },
      ),
    ).toEqual(["plugins.entries.xai.config.webSearch.apiKey"]);
    expect(
      diffConfigPaths(
        { plugins: { entries: { brave: { config: { webSearch: {} } } } } },
        { plugins: { entries: { brave: { config: {} } } } },
      ),
    ).toEqual(["plugins.entries.brave.config.webSearch"]);
  });

  it("keeps model catalog changes visible to the hot-reload planner", () => {
    const diffConfigPaths = buildDiffConfigPaths();

    expect(
      diffConfigPaths(
        { models: { providers: { link: { models: [{ id: "gpt-5.5" }] } } } },
        { models: { providers: { link: { models: [{ id: "gpt-5.6" }] } } } },
      ),
    ).toEqual(["models.providers.link.models"]);
  });

  it("is idempotent and fails closed when the upstream anchor changes", () => {
    const first = patchOpenClawGatewayReloadSource(
      ORIGINAL_DIFF_SOURCE,
      "test bundle",
    );
    const second = patchOpenClawGatewayReloadSource(
      first.source,
      "test bundle",
    );

    expect(first.patched).toBe(true);
    expect(first.source).toContain(CLAWPI_XAI_RELOAD_NORMALIZATION_MARKER);
    expect(second).toEqual({ source: first.source, patched: false });
    expect(() =>
      patchOpenClawGatewayReloadSource("function changedUpstream() {}"),
    ).toThrow("Unable to locate OpenClaw config diff anchor");
  });
});
