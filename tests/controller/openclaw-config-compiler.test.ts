import { describe, expect, it } from "vitest";
import type { ControllerEnv } from "../../apps/controller/src/app/env.js";
import { compileOpenClawConfig } from "../../apps/controller/src/lib/openclaw-config-compiler.js";

const env = {
  port: 3010,
  webUrl: "http://localhost:5173",
  openclawGatewayPort: 18789,
  openclawExtensionsDir: "/tmp/openclaw/extensions",
  openclawSkillsDir: "/tmp/openclaw/skills",
  userSkillsDir: "/tmp/user-skills",
  defaultModelId: "link/gpt-5.4",
  litellmBaseUrl: undefined,
  litellmApiKey: undefined,
} as unknown as ControllerEnv;

const baseConfig = {
  $schema: "https://api.clawpi.app:9443/config.json",
  schemaVersion: 1,
  app: {},
  bots: [],
  runtime: {
    gateway: {
      port: 18789,
      bind: "loopback",
      authMode: "none",
    },
    defaultModelId: "link/gpt-5.4",
  },
  providers: [],
  integrations: [],
  channels: [],
  templates: {},
  desktop: {},
  secrets: {},
} as const;

describe("compileOpenClawConfig gateway defaults", () => {
  it("always emits a local gateway configuration", () => {
    const compiled = compileOpenClawConfig(baseConfig as never, env);

    expect(compiled.gateway).toEqual({
      port: 18789,
      mode: "local",
      bind: "custom",
      customBindHost: "127.0.0.1",
      auth: {
        mode: "none",
      },
      reload: {
        mode: "hybrid",
      },
      controlUi: {
        allowedOrigins: ["http://localhost:5173"],
        dangerouslyAllowHostHeaderOriginFallback: true,
      },
    });
  });
});
