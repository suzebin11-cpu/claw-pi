import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fsState = vi.hoisted(() => {
  const paths = new Set<string>();
  const stampContents = new Map<string, string>();
  const isInside = (parent: string, child: string) =>
    child === parent ||
    child.startsWith(`${parent}/`) ||
    child.startsWith(`${parent}\\`);
  const removeTree = (target: string) => {
    for (const existing of Array.from(paths)) {
      if (isInside(target, existing)) {
        paths.delete(existing);
      }
    }
    for (const existing of Array.from(stampContents.keys())) {
      if (isInside(target, existing)) {
        stampContents.delete(existing);
      }
    }
  };
  const copyTree = (source: string, dest: string) => {
    for (const existing of Array.from(paths)) {
      if (isInside(source, existing)) {
        paths.add(`${dest}${existing.slice(source.length)}`);
      }
    }
    for (const [existing, contents] of Array.from(stampContents.entries())) {
      if (isInside(source, existing)) {
        stampContents.set(`${dest}${existing.slice(source.length)}`, contents);
      }
    }
  };
  const moveTree = (source: string, dest: string) => {
    copyTree(source, dest);
    removeTree(source);
  };

  return {
    paths,
    stampContents,
    archiveStamp: "123:456",
    copyTree,
    moveTree,
    removeTree,
  };
});

const execFileSyncMock = vi.hoisted(() => vi.fn());
const execSyncMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  execFileSync: execFileSyncMock,
  execSync: execSyncMock,
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
  rmSync: vi.fn((target: string) => {
    fsState.removeTree(target);
  }),
  renameSync: vi.fn((source: string, dest: string) => {
    fsState.moveTree(source, dest);
  }),
  cpSync: vi.fn((source: string, dest: string) => {
    fsState.copyTree(source, dest);
  }),
  readFileSync: vi.fn(
    (target: string) => fsState.stampContents.get(target) ?? "",
  ),
  statSync: vi.fn(() => ({ size: 123, mtimeMs: 456 })),
  writeFileSync: vi.fn((target: string, contents: string) => {
    fsState.paths.add(target);
    fsState.stampContents.set(target, contents);
  }),
}));

vi.mock("../../apps/desktop/main/runtime/lift-bundled-extension-deps", () => ({
  liftBundledExtensionDepsSync: vi.fn(() => ({
    failed: 0,
    linked: 0,
    skipped: 0,
  })),
}));

import {
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
  };
}

describe("desktop runtime manifests", () => {
  beforeEach(() => {
    fsState.paths.clear();
    fsState.stampContents.clear();
    execFileSyncMock.mockReset();
    execSyncMock.mockReset();
    execSyncMock.mockImplementation((command: string) => {
      const match = command.match(/^rmdir \/s \/q "(.+)"$/u);
      if (match?.[1]) {
        fsState.removeTree(match[1]);
      }
    });
  });

  describe("buildSkillNodePath", () => {
    it("prefers bundled desktop node_modules in dev", () => {
      const electronRoot = path.resolve("/repo/apps/desktop");
      const result = buildSkillNodePath(electronRoot, false, "");

      expect(result).toBe(path.resolve(electronRoot, "node_modules"));
    });

    it("prefers packaged bundled-node-modules for desktop dist", () => {
      const electronRoot = path.resolve(
        "/Applications/Nexu.app/Contents/Resources",
      );
      const result = buildSkillNodePath(electronRoot, true, "");

      expect(result).toBe(path.resolve(electronRoot, "bundled-node-modules"));
    });

    it("preserves inherited NODE_PATH entries without duplication", () => {
      const electronRoot = path.resolve("/repo/apps/desktop");
      const bundledPath = path.resolve(electronRoot, "node_modules");
      const inherited = [
        bundledPath,
        "/usr/local/lib/node_modules",
        "/opt/custom/node_modules",
      ].join(path.delimiter);

      const result = buildSkillNodePath(electronRoot, false, inherited);

      expect(result).toBe(
        [
          bundledPath,
          "/usr/local/lib/node_modules",
          "/opt/custom/node_modules",
        ].join(path.delimiter),
      );
    });
  });

  describe("ensurePackagedOpenclawSidecar", () => {
    it("reuses existing extracted sidecar when stamp and entry already match", () => {
      const runtimeSidecarBaseRoot = path.resolve(
        "/Applications/Nexu.app/Contents/Resources/runtime",
      );
      const runtimeRoot = path.resolve("/Users/testuser/.nexu");
      const archivePath = path.resolve(
        runtimeSidecarBaseRoot,
        "openclaw/payload.tar.gz",
      );
      const extractedRoot = path.resolve(runtimeRoot, "openclaw-sidecar");
      const stampPath = path.resolve(extractedRoot, ".archive-stamp");
      const entryPath = path.resolve(
        extractedRoot,
        "node_modules/openclaw/openclaw.mjs",
      );

      fsState.paths.add(archivePath);
      fsState.paths.add(stampPath);
      fsState.paths.add(entryPath);
      fsState.stampContents.set(stampPath, fsState.archiveStamp);

      const result = ensurePackagedOpenclawSidecar(
        runtimeSidecarBaseRoot,
        runtimeRoot,
      );

      expect(result).toBe(extractedRoot);
      expect(execFileSyncMock).not.toHaveBeenCalled();
    });

    it("extracts through staging, verifies entry, and atomically swaps into place", () => {
      const runtimeSidecarBaseRoot = path.resolve(
        "/Applications/Nexu.app/Contents/Resources/runtime",
      );
      const runtimeRoot = path.resolve("/Users/testuser/.nexu");
      const archivePath = path.resolve(
        runtimeSidecarBaseRoot,
        "openclaw/payload.tar.gz",
      );
      const extractedRoot = path.resolve(runtimeRoot, "openclaw-sidecar");
      const stagingRoot = `${extractedRoot}.staging`;
      const stagingEntry = path.resolve(
        stagingRoot,
        "node_modules/openclaw/openclaw.mjs",
      );

      fsState.paths.add(archivePath);

      execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "tar" && args[3] === stagingRoot) {
          fsState.paths.add(stagingRoot);
          fsState.paths.add(stagingEntry);
        }
      });

      const result = ensurePackagedOpenclawSidecar(
        runtimeSidecarBaseRoot,
        runtimeRoot,
      );

      expect(result).toBe(extractedRoot);
      expect(execFileSyncMock).toHaveBeenCalledWith("tar", [
        "-xzf",
        archivePath,
        "-C",
        stagingRoot,
      ]);
      expect(
        fsState.paths.has(
          path.resolve(extractedRoot, "node_modules/openclaw/openclaw.mjs"),
        ),
      ).toBe(true);
      expect(fsState.paths.has(stagingRoot)).toBe(false);
      expect(
        fsState.stampContents.get(
          path.resolve(extractedRoot, ".archive-stamp"),
        ),
      ).toBe(fsState.archiveStamp);
    });

    it("cleans leftover staging directories before a fresh extraction", () => {
      const runtimeSidecarBaseRoot = path.resolve(
        "/Applications/Nexu.app/Contents/Resources/runtime",
      );
      const runtimeRoot = path.resolve("/Users/testuser/.nexu");
      const archivePath = path.resolve(
        runtimeSidecarBaseRoot,
        "openclaw/payload.tar.gz",
      );
      const extractedRoot = path.resolve(runtimeRoot, "openclaw-sidecar");
      const stagingRoot = `${extractedRoot}.staging`;
      const stagingEntry = path.resolve(
        stagingRoot,
        "node_modules/openclaw/openclaw.mjs",
      );

      fsState.paths.add(archivePath);
      fsState.paths.add(stagingRoot);

      execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "tar" && args[3] === stagingRoot) {
          fsState.paths.add(stagingRoot);
          fsState.paths.add(stagingEntry);
        }
      });

      ensurePackagedOpenclawSidecar(runtimeSidecarBaseRoot, runtimeRoot);

      if (process.platform === "win32") {
        expect(execSyncMock).toHaveBeenCalledWith(
          `rmdir /s /q "${stagingRoot}"`,
          { stdio: "ignore", timeout: 30_000 },
        );
      }
      expect(execFileSyncMock).toHaveBeenCalledWith("tar", [
        "-xzf",
        archivePath,
        "-C",
        stagingRoot,
      ]);
    });

    it("retries extraction after a transient tar failure and succeeds on the next attempt", () => {
      const runtimeSidecarBaseRoot = path.resolve(
        "/Applications/Nexu.app/Contents/Resources/runtime",
      );
      const runtimeRoot = path.resolve("/Users/testuser/.nexu");
      const archivePath = path.resolve(
        runtimeSidecarBaseRoot,
        "openclaw/payload.tar.gz",
      );
      const extractedRoot = path.resolve(runtimeRoot, "openclaw-sidecar");
      const stagingRoot = `${extractedRoot}.staging`;
      const stagingEntry = path.resolve(
        stagingRoot,
        "node_modules/openclaw/openclaw.mjs",
      );
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
        runtimeSidecarBaseRoot,
        runtimeRoot,
      );

      expect(result).toBe(extractedRoot);
      expect(tarAttempts).toBe(2);
    });

    it("throws after retries when extraction never produces the critical entry", () => {
      const runtimeSidecarBaseRoot = path.resolve(
        "/Applications/Nexu.app/Contents/Resources/runtime",
      );
      const runtimeRoot = path.resolve("/Users/testuser/.nexu");
      const archivePath = path.resolve(
        runtimeSidecarBaseRoot,
        "openclaw/payload.tar.gz",
      );
      const extractedRoot = path.resolve(runtimeRoot, "openclaw-sidecar");
      const stagingRoot = `${extractedRoot}.staging`;

      fsState.paths.add(archivePath);

      execFileSyncMock.mockImplementation((cmd: string, args: string[]) => {
        if (cmd === "tar" && args[3] === stagingRoot) {
          fsState.paths.add(stagingRoot);
        }
      });

      expect(() =>
        ensurePackagedOpenclawSidecar(runtimeSidecarBaseRoot, runtimeRoot),
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
  });

  describe("createRuntimeUnitManifests", () => {
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
      });
    });

    it("passes packaged standalone node to the controller when available", () => {
      const nodeExecutable = path.resolve(
        "/Applications/Nexu.app/Contents/Resources/runtime/node/bin/node.exe",
      );
      fsState.paths.add(nodeExecutable);
      execFileSyncMock.mockReturnValue("24.11.1\n");

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
        OPENCLAW_NODE_EXECUTABLE: nodeExecutable,
      });
      expect(controllerManifest?.env?.PATH?.split(path.delimiter)[0]).toBe(
        path.dirname(nodeExecutable),
      );
    });
  });
});
