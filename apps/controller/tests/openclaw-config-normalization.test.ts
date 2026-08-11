import type { OpenClawConfig } from "@nexu/shared";
import { describe, expect, it } from "vitest";
import {
  normalizeOpenClawConfig,
  openClawConfigRevision,
} from "../src/lib/openclaw-config-normalization.js";

function makeConfig(
  xai: Record<string, unknown> = { enabled: true },
): OpenClawConfig {
  return {
    gateway: {
      port: 18789,
      mode: "local",
      bind: "custom",
      customBindHost: "127.0.0.1",
      auth: { mode: "none" },
    },
    agents: { defaults: {}, list: [] },
    channels: {},
    bindings: [],
    models: { providers: {} },
    plugins: {
      load: { paths: [] },
      entries: { xai },
    },
    skills: { load: { watch: true } },
    commands: { native: "auto" },
  } as OpenClawConfig;
}

describe("OpenClaw config normalization", () => {
  it("pins only the xAI enabled-by-default state", () => {
    const normalized = normalizeOpenClawConfig(makeConfig());
    expect(normalized.plugins?.entries?.xai).toEqual({ enabled: true });
  });

  it("preserves valid xAI plugin configuration without inventing fields", () => {
    const normalized = normalizeOpenClawConfig(
      makeConfig({
        config: {
          webSearch: { apiKey: "xai-key", model: "grok-4" },
          xSearch: { enabled: false },
        },
      }),
    );

    expect(normalized.plugins?.entries?.xai).toEqual({
      enabled: true,
      config: {
        webSearch: { apiKey: "xai-key", model: "grok-4" },
        xSearch: { enabled: false },
      },
    });
  });

  it("removes the legacy xAI webSearch enabled flag rejected by OpenClaw 2026.4", () => {
    const normalized = normalizeOpenClawConfig(
      makeConfig({
        enabled: true,
        config: {
          webSearch: {
            enabled: false,
            apiKey: "xai-key",
            model: "grok-4",
          },
        },
      }),
    );

    expect(normalized.plugins?.entries?.xai).toEqual({
      enabled: true,
      config: {
        webSearch: {
          apiKey: "xai-key",
          model: "grok-4",
        },
      },
    });
  });

  it("drops an empty legacy xAI config block", () => {
    const normalized = normalizeOpenClawConfig(
      makeConfig({
        config: {
          webSearch: { enabled: false },
        },
      }),
    );

    expect(normalized.plugins?.entries?.xai).toEqual({ enabled: true });
  });

  it("does not change revision when xAI enabled is made explicit", () => {
    const implicit = makeConfig({});
    const explicit = makeConfig({ enabled: true });
    expect(openClawConfigRevision(implicit)).toBe(
      openClawConfigRevision(explicit),
    );
  });
});
