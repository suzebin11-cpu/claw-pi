import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => ({
  paths: new Set<string>(),
  stampContents: new Map<string, string>(),
  archiveStamp: "123:456",
}));

const execFileSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execFile: vi.fn(
    (_cmd: unknown, _args: unknown, cb?: (...a: unknown[]) => void) => {
      cb?.(null, "", "");
    },
  ),
}));

vi.mock("node:util", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:util")>();
  return {
    ...actual,
    promisify: () => vi.fn().mockResolvedValue({ stdout: "", stderr: "" }),
  };
});

vi.mock("node:fs", () => ({
  existsSync: vi.fn((target: string) => fsState.paths.has(target)),
  mkdirSync: vi.fn((target: string) => {
    fsState.paths.add(target);
  }),
  readFileSync: vi.fn(
    (target: string) => fsState.stampContents.get(target) ?? "",
  ),
  statSync: vi.fn(() => ({ size: 123, mtimeMs: 456 })),
  rmSync: vi.fn((target: string) => {
    fsState.paths.delete(target);
    fsState.stampContents.delete(target);
  }),
  renameSync: vi.fn((source: string, target: string) => {
    for (const existingPath of [...fsState.paths]) {
      if (existingPath === source || existingPath.startsWith(`${source}/`)) {
        fsState.paths.delete(existingPath);
        fsState.paths.add(
          `${target}${existingPath.slice(source.length)}`,
        );
      }
    }
    for (const [existingPath, contents] of [...fsState.stampContents]) {
      if (existingPath === source || existingPath.startsWith(`${source}/`)) {
        fsState.stampContents.delete(existingPath);
        fsState.stampContents.set(
          `${target}${existingPath.slice(source.length)}`,
          contents,
        );
      }
    }
  }),
  writeFileSync: vi.fn((target: string, contents: string) => {
    fsState.paths.add(target);
    fsState.stampContents.set(target, contents);
  }),
}));

import {
  assertOpenclawLauncherAvailable,
  buildSkillNodePath,
  createRuntimeUnitManifests,
  ensurePackagedOpenclawSidecar,
} from "../../apps/desktop/main/runtime/manifests";
import { readProxyPolicy } from "../../apps/desktop/shared/proxy-config";
import type { DesktopRuntimeConfig } from "../../apps/desktop/shared/runtime-config";

function createRuntimeConfig(): DesktopRuntimeConfig {
  return {
    buildInfo: {
      version: "1.0.0",
      source: "local-dev",
      branch: null,
      commit: null,
      builtAt: null,
    },
    proxy: readProxyPolicy({
      HTTP_PROXY: "http://proxy.example.com:8080",
      HTTPS_PROXY: "http://secure-proxy.example.com:8443",
      ALL_PROXY: "socks5://proxy.example.com:1080",
      NO_PROXY: "example.com",
    }),
    updates: {
      autoUpdateEnabled: true,
      channel: "stable",
    },
    ports: {
      controller: 50800,
      web: 50810,
    },
    urls: {
      controllerBase: "http://127.0.0.1:50800",
      web: "http://127.0.0.1:50810",
      openclawBase: "http://127.0.0.1:18789",
      cloudBase: "https://api.clawpi.app:9443",
      linkBase: "https://api.clawpi.app:9443",
      updateFeed: null,
    },
    tokens: {
      gateway: "gw-secret-token",
    },
    paths: {
      nexuHome: "/tmp/nexu-home",
      openclawBin: "openclaw-wrapper",
    },
    desktopAuth: {
      name: "NexU Desktop",
      email: "desktop@nexu.local",
      password: "desktop-local-password",
    },
    sentryDsn: null,
    amplitudeApiKey: null,
  };
}

describe("desktop runtime manifests", () => {
  beforeEach(() => {
    fsState.paths.clear();
    fsState.stampContents.clear();
    execFileSyncMock.mockReset();
  });

  describe("assertOpenclawLauncherAvailable", () => {
    it("accepts an existing launcher", () => {
      const launcherPath = path.resolve("tmp", "openclaw", "bin", "openclaw");
      fsState.paths.add(launcherPath);

      expect(() =>
        assertOpenclawLauncherAvailable(launcherPath, false),
      ).not.toThrow();
    });

    it("gives a development recovery command when the launcher is missing", () => {
      const launcherPath = path.resolve("tmp", "openclaw", "bin", "openclaw");

      expect(() =>
        assertOpenclawLauncherAvailable(launcherPath, false),
      ).toThrow("prepare:runtime-sidecars");
    });

    it("identifies a damaged packaged runtime when the launcher is missing", () => {
      const launcherPath = path.resolve("runtime", "openclaw", "bin", "openclaw");

      expect(() =>
        assertOpenclawLauncherAvailable(launcherPath, true),
      ).toThrow("Reinstall Claw-Pi");
    });
  });

  describe("buildSkillNodePath", () => {
    it("prefers bundled desktop node_modules in dev", () => {
      const desktopRoot = path.resolve("repo", "apps", "desktop");
      const result = buildSkillNodePath(desktopRoot, false, "");

      expect(result).toBe(path.resolve(desktopRoot, "node_modules"));
    });

    it("prefers packaged bundled-node-modules for desktop dist", () => {
      const resourcesRoot = path.resolve(
        "Applications",
        "Nexu.app",
        "Resources",
      );
      const result = buildSkillNodePath(resourcesRoot, true, "");

      expect(result).toBe(path.resolve(resourcesRoot, "bundled-node-modules"));
    });

    it("preserves inherited NODE_PATH entries without duplication", () => {
      const desktopRoot = path.resolve("repo", "apps", "desktop");
      const bundledPath = path.resolve(desktopRoot, "node_modules");
      const inherited = [
        bundledPath,
        path.resolve("usr", "local", "lib", "node_modules"),
        path.resolve("opt", "custom", "node_modules"),
      ].join(path.delimiter);

      const result = buildSkillNodePath(desktopRoot, false, inherited);

      expect(result).toBe(
        [
          bundledPath,
          path.resolve("usr", "local", "lib", "node_modules"),
          path.resolve("opt", "custom", "node_modules"),
        ].join(path.delimiter),
      );
    });
  });

  describe.skipIf(process.platform === "win32")(
    "ensurePackagedOpenclawSidecar",
    () => {
      it("reuses existing extracted sidecar when stamp and entry already match", () => {
        const archivePath =
          "/Applications/Nexu.app/Contents/Resources/runtime/openclaw/payload.tar.gz";
        const extractedRoot = "/Users/testuser/.nexu/openclaw-sidecar";
        const stampPath = `${extractedRoot}/.archive-stamp`;
        const entryPath = `${extractedRoot}/node_modules/openclaw/openclaw.mjs`;

        fsState.paths.add(archivePath);
        fsState.paths.add(stampPath);
        fsState.paths.add(entryPath);
        fsState.stampContents.set(stampPath, fsState.archiveStamp);

        const result = ensurePackagedOpenclawSidecar(
          "/Applications/Nexu.app/Contents/Resources/runtime",
          "/Users/testuser/.nexu",
        );

        expect(result).toBe(extractedRoot);
        expect(execFileSyncMock).not.toHaveBeenCalled();
      });

      it("extracts through staging, verifies entry, and atomically swaps into place", () => {
        const archivePath =
          "/Applications/Nexu.app/Contents/Resources/runtime/openclaw/payload.tar.gz";
        const extractedRoot = "/Users/testuser/.nexu/openclaw-sidecar";
        const stagingRoot = `${extractedRoot}.staging`;
        const stagingEntry = `${stagingRoot}/node_modules/openclaw/openclaw.mjs`;

        fsState.paths.add(archivePath);

        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
          if (cmd === "tar" && args[3] === stagingRoot) {
            fsState.paths.add(stagingRoot);
            fsState.paths.add(stagingEntry);
          }
        });

        const result = ensurePackagedOpenclawSidecar(
          "/Applications/Nexu.app/Contents/Resources/runtime",
          "/Users/testuser/.nexu",
        );

        expect(result).toBe(extractedRoot);
        expect(execFileSyncMock).toHaveBeenCalledWith("tar", [
          "-xzf",
          archivePath,
          "-C",
          stagingRoot,
        ]);
        expect(fsState.paths.has(extractedRoot)).toBe(true);
        expect(
          fsState.paths.has(
            `${extractedRoot}/node_modules/openclaw/openclaw.mjs`,
          ),
        ).toBe(true);
        expect(
          fsState.stampContents.get(`${extractedRoot}/.archive-stamp`),
        ).toBe(fsState.archiveStamp);
      });

      it("cleans leftover staging directories before a fresh extraction", () => {
        const archivePath =
          "/Applications/Nexu.app/Contents/Resources/runtime/openclaw/payload.tar.gz";
        const extractedRoot = "/Users/testuser/.nexu/openclaw-sidecar";
        const stagingRoot = `${extractedRoot}.staging`;
        const stagingEntry = `${stagingRoot}/node_modules/openclaw/openclaw.mjs`;

        fsState.paths.add(archivePath);
        fsState.paths.add(stagingRoot);

        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
          if (cmd === "tar" && args[3] === stagingRoot) {
            fsState.paths.add(stagingRoot);
            fsState.paths.add(stagingEntry);
          }
        });

        ensurePackagedOpenclawSidecar(
          "/Applications/Nexu.app/Contents/Resources/runtime",
          "/Users/testuser/.nexu",
        );

        expect(execFileSyncMock).toHaveBeenCalledWith("tar", [
          "-xzf",
          archivePath,
          "-C",
          stagingRoot,
        ]);
        expect(fsState.paths.has(stagingRoot)).toBe(false);
      });

      it("retries extraction after a transient tar failure and succeeds on the next attempt", () => {
        const archivePath =
          "/Applications/Nexu.app/Contents/Resources/runtime/openclaw/payload.tar.gz";
        const extractedRoot = "/Users/testuser/.nexu/openclaw-sidecar";
        const stagingRoot = `${extractedRoot}.staging`;
        const stagingEntry = `${stagingRoot}/node_modules/openclaw/openclaw.mjs`;
        let tarAttempts = 0;

        fsState.paths.add(archivePath);

        execFileSyncMock.mockImplementation((cmd: string, _args: string[]) => {
          if (cmd === "tar") {
            tarAttempts++;
            if (tarAttempts === 1) {
              throw new Error("tar exploded");
            }
            fsState.paths.add(stagingRoot);
            fsState.paths.add(stagingEntry);
          }
        });

        const result = ensurePackagedOpenclawSidecar(
          "/Applications/Nexu.app/Contents/Resources/runtime",
          "/Users/testuser/.nexu",
        );

        expect(result).toBe(extractedRoot);
        expect(tarAttempts).toBe(2);
        expect(
          execFileSyncMock.mock.calls.some(([cmd]) => cmd === "sleep"),
        ).toBe(false);
      });

      it("throws after retries when extraction never produces the critical entry", () => {
        const archivePath =
          "/Applications/Nexu.app/Contents/Resources/runtime/openclaw/payload.tar.gz";
        const extractedRoot = "/Users/testuser/.nexu/openclaw-sidecar";
        const stagingRoot = `${extractedRoot}.staging`;

        fsState.paths.add(archivePath);

        execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
          if (cmd === "tar" && args[3] === stagingRoot) {
            fsState.paths.add(stagingRoot);
          }
        });

        expect(() =>
          ensurePackagedOpenclawSidecar(
            "/Applications/Nexu.app/Contents/Resources/runtime",
            "/Users/testuser/.nexu",
          ),
        ).toThrow("Extraction verification failed");

        const tarCalls = execFileSyncMock.mock.calls.filter(
          ([cmd]) => cmd === "tar",
        );
        const sleepCalls = execFileSyncMock.mock.calls.filter(
          ([cmd]) => cmd === "sleep",
        );
        expect(tarCalls).toHaveLength(3);
        expect(sleepCalls).toHaveLength(0);
      });
    },
  );

  describe("createRuntimeUnitManifests", () => {
    it("uses an absolute user-data skills path in development", () => {
      const userDataPath = path.resolve("tmp", "desktop-user-data");
      const runtimeConfig = createRuntimeConfig();
      runtimeConfig.paths.nexuHome = "~/.claw-pi";

      const manifests = createRuntimeUnitManifests(
        path.resolve("apps", "desktop"),
        userDataPath,
        false,
        runtimeConfig,
      );
      const controllerManifest = manifests.find(
        (manifest) => manifest.id === "controller",
      );

      expect(controllerManifest?.env?.OPENCLAW_SKILLS_DIR).toBe(
        path.resolve(userDataPath, "runtime/openclaw/state/skills"),
      );
      expect(
        path.isAbsolute(controllerManifest?.env?.OPENCLAW_SKILLS_DIR ?? ""),
      ).toBe(true);
    });

    it("propagates normalized proxy env to dev web and controller manifests", () => {
      const manifests = createRuntimeUnitManifests(
        "/repo/apps/desktop",
        "/tmp/user-data",
        false,
        createRuntimeConfig(),
      );

      const webManifest = manifests.find((manifest) => manifest.id === "web");
      const controllerManifest = manifests.find(
        (manifest) => manifest.id === "controller",
      );

      expect(webManifest?.env).toMatchObject({
        HTTP_PROXY: "http://proxy.example.com:8080",
        HTTPS_PROXY: "http://secure-proxy.example.com:8443",
        ALL_PROXY: "socks5://proxy.example.com:1080",
        NO_PROXY: "example.com,localhost,127.0.0.1,::1",
      });
      expect(controllerManifest?.env).toMatchObject({
        HTTP_PROXY: "http://proxy.example.com:8080",
        HTTPS_PROXY: "http://secure-proxy.example.com:8443",
        ALL_PROXY: "socks5://proxy.example.com:1080",
        NO_PROXY: "example.com,localhost,127.0.0.1,::1",
      });
    });

    it("propagates normalized proxy env to packaged controller manifest", () => {
      const manifests = createRuntimeUnitManifests(
        "/Applications/Nexu.app/Contents/Resources",
        "/Users/testuser/Library/Application Support/@nexu/desktop",
        true,
        createRuntimeConfig(),
      );

      const controllerManifest = manifests.find(
        (manifest) => manifest.id === "controller",
      );

      expect(controllerManifest?.env).toMatchObject({
        HTTP_PROXY: "http://proxy.example.com:8080",
        HTTPS_PROXY: "http://secure-proxy.example.com:8443",
        ALL_PROXY: "socks5://proxy.example.com:1080",
        NO_PROXY: "example.com,localhost,127.0.0.1,::1",
        NEXU_CLOUD_URL: "https://api.clawpi.app:9443",
        NEXU_LINK_URL: "https://api.clawpi.app:9443",
      });
    });

    it("enables the packaged controller gateway liveness probe", () => {
      const manifests = createRuntimeUnitManifests(
        "/Applications/Nexu.app/Contents/Resources",
        "/Users/testuser/Library/Application Support/@nexu/desktop",
        true,
        createRuntimeConfig(),
      );

      const controllerManifest = manifests.find(
        (manifest) => manifest.id === "controller",
      );

      expect(controllerManifest?.env?.RUNTIME_GATEWAY_PROBE_ENABLED).toBe(
        "true",
      );
    });
  });
});
