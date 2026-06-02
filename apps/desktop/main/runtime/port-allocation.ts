import { execFile } from "node:child_process";
import { createServer } from "node:net";
import { promisify } from "node:util";
import type { DesktopRuntimeConfig } from "../../shared/runtime-config";

type PortPurpose = "controller" | "web" | "openclaw";

export type PortAllocationErrorCode =
  | "idle_port_unavailable"
  | "runtime_port_conflict";

type PortAllocationRequest = {
  purpose: PortPurpose;
  preferredPort: number;
  explicit: boolean;
  host?: string;
  maxAttempts?: number;
};

export type PortAllocation = {
  purpose: PortPurpose;
  preferredPort: number;
  port: number;
  strategy: "explicit" | "probed";
  attemptDelta: number;
};

export type DesktopPortAllocationResult = {
  runtimeConfig: DesktopRuntimeConfig;
  allocations: PortAllocation[];
};

export class PortAllocationError extends Error {
  readonly code: PortAllocationErrorCode;
  readonly purpose: PortPurpose | "bundle";
  readonly preferredPort: number | null;

  constructor(input: {
    code: PortAllocationErrorCode;
    message: string;
    purpose: PortPurpose | "bundle";
    preferredPort?: number | null;
  }) {
    super(input.message);
    this.name = "PortAllocationError";
    this.code = input.code;
    this.purpose = input.purpose;
    this.preferredPort = input.preferredPort ?? null;
  }
}

let portAllocationLock: Promise<void> = Promise.resolve();
const execFileAsync = promisify(execFile);
const WINDOWS_PORT_RECLAIM_WAIT_MS = 8_000;

function hasExplicitEnvValue(value: string | undefined): boolean {
  return (value?.trim().length ?? 0) !== 0;
}

function replaceUrlPort(input: string, port: number): string {
  const url = new URL(input);
  url.port = String(port);
  return url.toString().replace(/\/$/, "");
}

function readUrlPort(input: string): number | null {
  const url = new URL(input);
  if (url.port.length === 0) {
    return null;
  }

  return Number.parseInt(url.port, 10);
}

export async function withPortAllocationLock<T>(
  callback: () => Promise<T>,
): Promise<T> {
  const previousLock = portAllocationLock;
  let releaseLock = () => {};
  portAllocationLock = new Promise<void>((resolve) => {
    releaseLock = resolve;
  });

  await previousLock;

  try {
    return await callback();
  } finally {
    releaseLock();
  }
}

async function probeIdlePort(options: {
  host: string;
  preferredPort: number;
  maxAttempts: number;
  excludedPorts?: ReadonlySet<number>;
}): Promise<number> {
  const { host, preferredPort, maxAttempts, excludedPorts } = options;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const candidatePort = preferredPort + attempt;

    if (excludedPorts?.has(candidatePort)) {
      continue;
    }

    const server = createServer();

    try {
      const port = await new Promise<number>((resolvePort, rejectPort) => {
        server.once("error", rejectPort);
        server.listen(candidatePort, host, () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            rejectPort(new Error("Could not determine idle port."));
            return;
          }

          resolvePort(address.port);
        });
      });

      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }

          resolveClose();
        });
      });

      return port;
    } catch (error) {
      server.close();

      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        (error.code === "EADDRINUSE" ||
          (process.platform === "win32" && error.code === "EACCES"))
      ) {
        continue;
      }

      throw error;
    }
  }

  return await probeEphemeralPort({ host, excludedPorts });
}

function isWindowsPortReclaimDisabled(): boolean {
  const value = process.env.NEXU_DESKTOP_DISABLE_PORT_RECLAIM;
  return value === "1" || value?.toLowerCase() === "true";
}

function shouldReclaimWindowsPorts(): boolean {
  return process.platform === "win32" && !isWindowsPortReclaimDisabled();
}

function localAddressMatchesPort(localAddress: string, port: number): boolean {
  return (
    localAddress.endsWith(`:${port}`) || localAddress.endsWith(`]:${port}`)
  );
}

async function assertExactPortIdle(options: {
  host: string;
  port: number;
  purpose: PortPurpose;
}): Promise<number> {
  const server = createServer();

  try {
    const port = await new Promise<number>((resolvePort, rejectPort) => {
      server.once("error", rejectPort);
      server.listen(options.port, options.host, () => {
        const address = server.address();
        if (!address || typeof address === "string") {
          rejectPort(new Error("Could not determine idle port."));
          return;
        }

        resolvePort(address.port);
      });
    });

    await new Promise<void>((resolveClose, rejectClose) => {
      server.close((error) => {
        if (error) {
          rejectClose(error);
          return;
        }

        resolveClose();
      });
    });

    return port;
  } catch (error) {
    try {
      server.close();
    } catch {
      // The server may not have reached the listening state.
    }
    throw new PortAllocationError({
      code: "idle_port_unavailable",
      message:
        error instanceof Error
          ? `Could not bind ${options.purpose} port ${options.port}: ${error.message}`
          : `Could not bind ${options.purpose} port ${options.port}.`,
      purpose: options.purpose,
      preferredPort: options.port,
    });
  }
}

async function detectWindowsTcpListenPids(port: number): Promise<number[]> {
  if (process.platform !== "win32") {
    return [];
  }

  const { stdout } = await execFileAsync("netstat", ["-ano", "-p", "tcp"], {
    encoding: "utf8",
    windowsHide: true,
  });
  const pids = new Set<number>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.toUpperCase().startsWith("TCP")) {
      continue;
    }

    const parts = line.split(/\s+/);
    if (parts.length < 5) {
      continue;
    }

    const localAddress = parts[1] ?? "";
    const state = parts[3]?.toUpperCase() ?? "";
    const pidText = parts.at(-1) ?? "";
    const pid = Number.parseInt(pidText, 10);

    if (
      state === "LISTENING" &&
      Number.isFinite(pid) &&
      pid > 0 &&
      pid !== process.pid &&
      localAddressMatchesPort(localAddress, port)
    ) {
      pids.add(pid);
    }
  }

  return [...pids];
}

async function waitForPortRelease(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const pids = await detectWindowsTcpListenPids(port);
    if (pids.length === 0) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  const remainingPids = await detectWindowsTcpListenPids(port);
  if (remainingPids.length > 0) {
    throw new Error(
      `Port ${port} is still occupied by pid(s): ${remainingPids.join(", ")}`,
    );
  }
}

async function reclaimWindowsTcpPort(port: number): Promise<void> {
  if (!shouldReclaimWindowsPorts() || port <= 0) {
    return;
  }

  const pids = await detectWindowsTcpListenPids(port);
  if (pids.length === 0) {
    return;
  }

  for (const pid of pids) {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/F", "/T"], {
        windowsHide: true,
      });
      console.warn(`[desktop:ports] reclaimed port=${port} pid=${pid}`);
    } catch (error) {
      console.warn(
        `[desktop:ports] failed to reclaim port=${port} pid=${pid}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  await waitForPortRelease(port, WINDOWS_PORT_RECLAIM_WAIT_MS);
}

async function probeEphemeralPort(options: {
  host: string;
  excludedPorts?: ReadonlySet<number>;
}): Promise<number> {
  const { host, excludedPorts } = options;

  for (let attempt = 0; attempt < 20; attempt += 1) {
    const server = createServer();

    try {
      const port = await new Promise<number>((resolvePort, rejectPort) => {
        server.once("error", rejectPort);
        server.listen(0, host, () => {
          const address = server.address();
          if (!address || typeof address === "string") {
            rejectPort(new Error("Could not determine idle port."));
            return;
          }

          resolvePort(address.port);
        });
      });

      await new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error) {
            rejectClose(error);
            return;
          }

          resolveClose();
        });
      });

      if (!excludedPorts?.has(port)) {
        return port;
      }
    } catch (error) {
      server.close();

      if (attempt === 19) {
        throw error;
      }
    }
  }

  throw new Error(`Could not find an idle ephemeral port for ${host}.`);
}

export async function requireIdlePort<T>(
  request: PortAllocationRequest,
  callback: (port: number) => Promise<T>,
): Promise<T> {
  return withPortAllocationLock(async () => {
    await reclaimWindowsTcpPort(request.preferredPort);

    const port = shouldReclaimWindowsPorts()
      ? await assertExactPortIdle({
          host: request.host ?? "127.0.0.1",
          port: request.preferredPort,
          purpose: request.purpose,
        })
      : request.explicit
        ? request.preferredPort
        : await probeIdlePort({
            host: request.host ?? "127.0.0.1",
            preferredPort: request.preferredPort,
            maxAttempts: request.maxAttempts ?? 100,
          });

    return callback(port);
  });
}

export async function allocateDesktopRuntimePorts(
  env: Record<string, string | undefined>,
  runtimeConfig: DesktopRuntimeConfig,
): Promise<DesktopPortAllocationResult> {
  const explicitControllerUrl =
    hasExplicitEnvValue(env.NEXU_CONTROLLER_URL) ||
    hasExplicitEnvValue(env.NEXU_CONTROLLER_BASE_URL) ||
    hasExplicitEnvValue(env.NEXU_API_URL) ||
    hasExplicitEnvValue(env.NEXU_API_BASE_URL);
  const explicitControllerPort =
    hasExplicitEnvValue(env.NEXU_CONTROLLER_PORT) ||
    hasExplicitEnvValue(env.NEXU_API_PORT);
  const explicitWebUrl = hasExplicitEnvValue(env.NEXU_WEB_URL);
  const explicitWebPort = hasExplicitEnvValue(env.NEXU_WEB_PORT);
  const explicitOpenclawUrl = hasExplicitEnvValue(env.NEXU_OPENCLAW_BASE_URL);
  const requests: PortAllocationRequest[] = [
    {
      purpose: "controller",
      preferredPort:
        readUrlPort(runtimeConfig.urls.controllerBase) ??
        runtimeConfig.ports.controller,
      explicit: explicitControllerPort || explicitControllerUrl,
    },
    {
      purpose: "web",
      preferredPort:
        readUrlPort(runtimeConfig.urls.web) ?? runtimeConfig.ports.web,
      explicit: explicitWebPort || explicitWebUrl,
    },
    {
      purpose: "openclaw",
      preferredPort: readUrlPort(runtimeConfig.urls.openclawBase) ?? 18_789,
      explicit: explicitOpenclawUrl,
    },
  ];

  return withPortAllocationLock(async () => {
    const usedPorts = new Set<number>();
    const allocations = new Map<PortPurpose, PortAllocation>();

    for (const request of requests) {
      await reclaimWindowsTcpPort(request.preferredPort);

      const strategy = request.explicit ? "explicit" : "probed";
      let port = request.preferredPort;

      if (shouldReclaimWindowsPorts()) {
        port = await assertExactPortIdle({
          host: request.host ?? "127.0.0.1",
          port: request.preferredPort,
          purpose: request.purpose,
        });
      } else if (!request.explicit) {
        try {
          port = await probeIdlePort({
            host: request.host ?? "127.0.0.1",
            preferredPort: request.preferredPort,
            maxAttempts: request.maxAttempts ?? 100,
            excludedPorts: usedPorts,
          });
        } catch (error) {
          throw new PortAllocationError({
            code: "idle_port_unavailable",
            message:
              error instanceof Error
                ? `Could not allocate ${request.purpose} port: ${error.message}`
                : `Could not allocate ${request.purpose} port.`,
            purpose: request.purpose,
            preferredPort: request.preferredPort,
          });
        }
      }

      if (usedPorts.has(port)) {
        throw new PortAllocationError({
          code: "runtime_port_conflict",
          message:
            `Desktop runtime port allocation conflict for ${request.purpose} ` +
            `on ${port}.`,
          purpose: "bundle",
          preferredPort: port,
        });
      }

      usedPorts.add(port);
      allocations.set(request.purpose, {
        purpose: request.purpose,
        preferredPort: request.preferredPort,
        port,
        strategy,
        attemptDelta: port - request.preferredPort,
      });
    }

    const controllerPort =
      allocations.get("controller")?.port ?? runtimeConfig.ports.controller;
    const webPort = allocations.get("web")?.port ?? runtimeConfig.ports.web;
    const openclawPort =
      allocations.get("openclaw")?.port ??
      readUrlPort(runtimeConfig.urls.openclawBase) ??
      18_789;

    return {
      runtimeConfig: {
        ...runtimeConfig,
        ports: {
          controller: controllerPort,
          web: webPort,
        },
        urls: {
          ...runtimeConfig.urls,
          controllerBase: explicitControllerUrl
            ? runtimeConfig.urls.controllerBase
            : replaceUrlPort(runtimeConfig.urls.controllerBase, controllerPort),
          web: explicitWebUrl
            ? runtimeConfig.urls.web
            : replaceUrlPort(runtimeConfig.urls.web, webPort),
          openclawBase: explicitOpenclawUrl
            ? runtimeConfig.urls.openclawBase
            : replaceUrlPort(runtimeConfig.urls.openclawBase, openclawPort),
        },
      },
      allocations: Array.from(allocations.values()),
    };
  });
}
