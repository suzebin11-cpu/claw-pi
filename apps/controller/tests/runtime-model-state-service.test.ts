import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import { RuntimeModelStateService } from "../src/services/runtime-model-state-service.js";

let rootDir: string | null = null;

function makeEnv(statePath: string): ControllerEnv {
  return {
    openclawRuntimeModelStatePath: statePath,
  } as ControllerEnv;
}

async function makeService(
  payload: unknown,
): Promise<RuntimeModelStateService> {
  rootDir = await mkdtemp(path.join(os.tmpdir(), "runtime-model-state-"));
  const statePath = path.join(rootDir, "nexu-runtime-model.json");
  await writeFile(statePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return new RuntimeModelStateService(makeEnv(statePath));
}

afterEach(async () => {
  if (rootDir) {
    await rm(rootDir, { recursive: true, force: true });
    rootDir = null;
  }
});

describe("RuntimeModelStateService", () => {
  it("returns a selected model when it is in the runtime whitelist", async () => {
    const service = await makeService({
      selectedModelRef: "link/gpt-5.4-mini",
      availableModelRefs: ["link/gpt-5.4-mini"],
    });

    await expect(service.getEffectiveModelId()).resolves.toBe(
      "link/gpt-5.4-mini",
    );
  });

  it("ignores a stale selected model when a whitelist is present", async () => {
    const service = await makeService({
      selectedModelRef: "debug/mock",
      availableModelRefs: ["link/gpt-5.4-mini"],
    });

    await expect(service.getEffectiveModelId()).resolves.toBeNull();
  });

  it("keeps legacy runtime state without a whitelist compatible", async () => {
    const service = await makeService({
      selectedModelRef: "link/gpt-5.4-mini",
    });

    await expect(service.getEffectiveModelId()).resolves.toBe(
      "link/gpt-5.4-mini",
    );
  });
});
