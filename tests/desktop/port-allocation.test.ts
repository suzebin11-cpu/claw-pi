import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { allocateDesktopRuntimePorts } from "#desktop/main/runtime/port-allocation";
import type { PortAllocationError } from "#desktop/main/runtime/port-allocation";
import type { DesktopRuntimeConfig } from "#desktop/shared/runtime-config";

const servers: Array<import("node:net").Server> = [];

function createRuntimeConfig(input?: {
  controllerPort?: number;
  webPort?: number;
  openclawPort?: number;
}): DesktopRuntimeConfig {
  const controllerPort = input?.controllerPort ?? 61_000;
  const webPort = input?.webPort ?? 61_010;
  const openclawPort = input?.openclawPort ?? 61_020;

  return {
    buildInfo: {
      version: "0.0.0",
      source: "local-dev",
      branch: null,
      commit: null,
      builtAt: null,
    },
    updates: {
      autoUpdateEnabled: true,
    },
    ports: {
      controller: controllerPort,
      web: webPort,
    },
    urls: {
      controllerBase: `http://127.0.0.1:${controllerPort}`,
      web: `http://127.0.0.1:${webPort}`,
      openclawBase: `http://127.0.0.1:${openclawPort}`,
      nexuCloud: "https://api.clawpi.app:9443",
      nexuLink: null,
      updateFeed: null,
    },
    tokens: {
      gateway: "gw-secret-token",
    },
    paths: {
      nexuHome: "~/.nexu",
      openclawBin: "openclaw-wrapper",
    },
    desktopAuth: {
      name: "NexU Desktop",
      email: "desktop@nexu.local",
      password: "desktop-local-password",
    },
    sentryDsn: null,
  };
}

async function listenOnEphemeralPort(): Promise<number> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();
    const port = await new Promise<number>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          reject(new Error("Could not determine ephemeral port."));
          return;
        }
        resolve(address.port);
      });
    });

    if (port < 65_000) {
      servers.push(server);
      return port;
    }

    await new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      });
    });
  }

  throw new Error("Could not reserve a usable ephemeral port.");
}

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => {
            if (error) {
              reject(error);
              return;
            }

            resolve();
          });
        }),
    ),
  );
});

describe("desktop port allocation", () => {
  it("probes the next idle port when preferred ports are occupied", async () => {
    const controllerPort = await listenOnEphemeralPort();
    const webPort = await listenOnEphemeralPort();
    const openclawPort = await listenOnEphemeralPort();
    const runtimeConfig = createRuntimeConfig({
      controllerPort,
      webPort,
      openclawPort,
    });

    const result = await allocateDesktopRuntimePorts({}, runtimeConfig);
    const allocatedOpenclawPort = Number.parseInt(
      new URL(result.runtimeConfig.urls.openclawBase).port,
      10,
    );

    expect(result.runtimeConfig.ports.controller).not.toBe(controllerPort);
    expect(result.runtimeConfig.ports.web).not.toBe(webPort);
    expect(allocatedOpenclawPort).not.toBe(openclawPort);
    expect(
      new Set([
        result.runtimeConfig.ports.controller,
        result.runtimeConfig.ports.web,
        allocatedOpenclawPort,
      ]).size,
    ).toBe(3);
    expect(result.allocations).toHaveLength(3);
    expect(result.allocations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          purpose: "controller",
          preferredPort: controllerPort,
          port: result.runtimeConfig.ports.controller,
          strategy: "probed",
        }),
        expect.objectContaining({
          purpose: "web",
          preferredPort: webPort,
          port: result.runtimeConfig.ports.web,
          strategy: "probed",
        }),
        expect.objectContaining({
          purpose: "openclaw",
          preferredPort: openclawPort,
          port: allocatedOpenclawPort,
          strategy: "probed",
        }),
      ]),
    );
    expect(result.allocations.every((item) => item.attemptDelta > 0)).toBe(
      true,
    );
  });

  it("throws a classified error when explicit ports conflict inside the bundle", async () => {
    const runtimeConfig = createRuntimeConfig({
      controllerPort: 62_000,
      webPort: 62_000,
    });

    await expect(
      allocateDesktopRuntimePorts(
        {
          NEXU_CONTROLLER_PORT: "62000",
          NEXU_WEB_PORT: "62000",
        },
        runtimeConfig,
      ),
    ).rejects.toMatchObject<Partial<PortAllocationError>>({
      name: "PortAllocationError",
      code: "runtime_port_conflict",
      purpose: "bundle",
      preferredPort: 62_000,
    });
  });
});
