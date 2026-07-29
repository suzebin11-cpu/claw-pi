import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { OpenClawConfig } from "@nexu/shared";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import { OpenClawAuthProfilesStore } from "../src/runtime/openclaw-auth-profiles-store.js";
import { OpenClawAuthProfilesWriter } from "../src/runtime/openclaw-auth-profiles-writer.js";

function makeConfig(workspace: string): OpenClawConfig {
  return {
    gateway: { port: 18789, mode: "local", bind: "127.0.0.1" },
    agents: {
      list: [{ id: "agent-1", workspace }],
      defaults: {},
    },
    models: {
      providers: {
        link: {
          baseUrl: "https://yunwu.ai/v1",
          apiKey: "sk-link",
          models: [{ id: "gpt-5.4-mini", name: "GPT-5.4 Mini" }],
        },
      },
    },
    channels: {},
    bindings: [],
    plugins: { load: { paths: [] }, entries: {} },
    skills: { load: { watch: true } },
    commands: { native: "auto" },
  } as OpenClawConfig;
}

describe("OpenClawAuthProfilesWriter", () => {
  let rootDir = "";
  let env: ControllerEnv;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-auth-writer-"));
    env = {
      openclawStateDir: path.join(rootDir, ".openclaw"),
    } as ControllerEnv;
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("drops stale openai-codex OAuth profiles while preserving other OAuth profiles", async () => {
    const workspace = path.join(env.openclawStateDir, "agents", "agent-1");
    const authDir = path.join(workspace, "agent");
    const authPath = path.join(authDir, "auth-profiles.json");
    await mkdir(authDir, { recursive: true });
    await writeFile(
      authPath,
      `${JSON.stringify(
        {
          version: 1,
          profiles: {
            "openai-codex:default": {
              type: "oauth",
              provider: "openai-codex",
              access: "stale-access",
            },
            "custom-oauth:default": {
              type: "oauth",
              provider: "custom-oauth",
              access: "keep-access",
            },
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    const writer = new OpenClawAuthProfilesWriter(
      new OpenClawAuthProfilesStore(env),
    );
    await writer.writeForAgents(makeConfig(workspace));

    const data = JSON.parse(await readFile(authPath, "utf8")) as {
      profiles: Record<string, unknown>;
    };
    expect(data.profiles["openai-codex:default"]).toBeUndefined();
    expect(data.profiles["custom-oauth:default"]).toMatchObject({
      provider: "custom-oauth",
    });
    expect(data.profiles["link:default"]).toMatchObject({
      type: "api_key",
      provider: "link",
      key: "sk-link",
    });
  });

  it("writes auth profiles for the implicit main agent when agents.list is empty", async () => {
    const writer = new OpenClawAuthProfilesWriter(
      new OpenClawAuthProfilesStore(env),
    );
    const config = makeConfig(
      path.join(env.openclawStateDir, "agents", "unused"),
    );
    config.agents.list = [];

    await writer.writeForAgents(config);

    const authPath = path.join(
      env.openclawStateDir,
      "agents",
      "main",
      "agent",
      "auth-profiles.json",
    );
    const data = JSON.parse(await readFile(authPath, "utf8")) as {
      profiles: Record<string, unknown>;
    };
    expect(data.profiles["link:default"]).toEqual({
      type: "api_key",
      provider: "link",
      key: "sk-link",
    });
  });

  it("writes auth profiles for implicit main and configured agent workspaces", async () => {
    const workspace = path.join(env.openclawStateDir, "agents", "agent-1");
    const writer = new OpenClawAuthProfilesWriter(
      new OpenClawAuthProfilesStore(env),
    );

    await writer.writeForAgents(makeConfig(workspace));

    for (const authPath of [
      path.join(
        env.openclawStateDir,
        "agents",
        "main",
        "agent",
        "auth-profiles.json",
      ),
      path.join(workspace, "agent", "auth-profiles.json"),
    ]) {
      const data = JSON.parse(await readFile(authPath, "utf8")) as {
        profiles: Record<string, unknown>;
      };
      expect(data.profiles["link:default"]).toEqual({
        type: "api_key",
        provider: "link",
        key: "sk-link",
      });
    }
  });
});
