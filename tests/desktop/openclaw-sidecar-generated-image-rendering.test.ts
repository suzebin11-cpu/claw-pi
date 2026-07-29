import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const SIDECAR_PREPARE_SCRIPT = readFileSync(
  resolve(REPO_ROOT, "apps/desktop/scripts/prepare-openclaw-sidecar.mjs"),
  "utf8",
);
const IMAGE_GENERATION_PLUGIN = readFileSync(
  resolve(
    REPO_ROOT,
    "apps/controller/static/runtime-plugins/clawpi-image-generation/index.js",
  ),
  "utf8",
);

describe("OpenClaw Control UI generated image patch", () => {
  it("patches the live Markdown image renderer with a local generated-image allowlist", () => {
    expect(SIDECAR_PREPARE_SCRIPT).toContain(
      "CONTROL_UI_MARKDOWN_IMAGE_RENDERER_SEARCH",
    );
    expect(SIDECAR_PREPARE_SCRIPT).toContain(
      "CONTROL_UI_MARKDOWN_IMAGE_RENDERER_REPLACEMENT",
    );
    expect(SIDECAR_PREPARE_SCRIPT).toContain(
      "127\\\\.0\\\\.0\\\\.1|localhost|\\\\[::1\\\\]",
    );
    expect(SIDECAR_PREPARE_SCRIPT).toContain(
      "api\\\\/internal\\\\/desktop\\\\/generated-images\\\\/",
    );
    expect(SIDECAR_PREPARE_SCRIPT).toContain("(?:png|jpe?g|webp|gif)");
  });

  it("keeps arbitrary remote images outside the live Markdown allowlist", () => {
    expect(SIDECAR_PREPARE_SCRIPT).toContain(
      "gg.test(n)||/^https?:\\\\/\\\\/(?:127\\\\.0\\\\.0\\\\.1|localhost|\\\\[::1\\\\]):\\\\d+\\\\/api\\\\/internal\\\\/desktop\\\\/generated-images\\\\/",
    );
  });

  it("keeps the historical structured-media and cache-busting patches", () => {
    expect(SIDECAR_PREPARE_SCRIPT).toContain(
      "preserve generated image media for Control UI history",
    );
    expect(SIDECAR_PREPARE_SCRIPT).toContain(
      "?clawpi-media=2&clawpi-node-poll=5s",
    );
  });

  it("keeps the image tool request alive for slow upstream generation", () => {
    expect(IMAGE_GENERATION_PLUGIN).toContain(
      "const CONTROLLER_FETCH_TIMEOUT_MS = 600_000",
    );
    expect(IMAGE_GENERATION_PLUGIN).not.toContain(
      "const CONTROLLER_FETCH_TIMEOUT_MS = 190_000",
    );
  });
});
