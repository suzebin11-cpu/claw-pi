import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { app, dialog } from "electron";
import {
  getDesktopNexuHomeDir,
  getPortableDataRoot,
  isPortableMode,
} from "../shared/desktop-paths";

function safeWrite(stream: NodeJS.WriteStream, message: string): void {
  if (stream.destroyed || !stream.writable) {
    return;
  }

  try {
    stream.write(message);
  } catch (error) {
    const errorCode =
      error instanceof Error && "code" in error ? String(error.code) : null;
    if (errorCode === "EIO" || errorCode === "EPIPE") {
      return;
    }
    throw error;
  }
}

function loadDesktopDevEnv(): void {
  const workspaceRoot = process.env.NEXU_WORKSPACE_ROOT;

  if (!workspaceRoot || app.isPackaged) {
    return;
  }

  const envPaths = [
    resolve(workspaceRoot, "apps/controller/.env"),
    resolve(workspaceRoot, "apps/desktop/.env"),
  ];

  for (const envPath of envPaths) {
    if (!existsSync(envPath)) {
      continue;
    }

    process.loadEnvFile(envPath);
  }
}

function configureLocalDevPaths(): void {
  const runtimeRoot = process.env.NEXU_DESKTOP_RUNTIME_ROOT;

  if (!runtimeRoot || app.isPackaged) {
    return;
  }

  const electronRoot = resolve(runtimeRoot, "electron");
  const userDataPath = resolve(electronRoot, "user-data");
  const sessionDataPath = resolve(electronRoot, "session-data");
  const logsPath = resolve(userDataPath, "logs");
  const nexuHomePath = getDesktopNexuHomeDir(userDataPath);

  mkdirSync(userDataPath, { recursive: true });
  mkdirSync(sessionDataPath, { recursive: true });
  mkdirSync(logsPath, { recursive: true });
  mkdirSync(nexuHomePath, { recursive: true });

  // Only set NEXU_HOME if not already provided externally (e.g. by
  // dev-launchd.sh). Unconditionally overwriting it breaks the data
  // directory when the caller explicitly sets NEXU_HOME to a custom path.
  if (!process.env.NEXU_HOME) {
    process.env.NEXU_HOME = nexuHomePath;
  }

  app.setPath("userData", userDataPath);
  app.setPath("sessionData", sessionDataPath);
  app.setAppLogsPath(logsPath);

  safeWrite(
    process.stdout,
    `[desktop:paths] runtimeRoot=${runtimeRoot} userData=${userDataPath} sessionData=${sessionDataPath} logs=${logsPath} nexuHome=${nexuHomePath}\n`,
  );
}

function getWindowsLocalAppDataPath(): string {
  const localAppData = process.env.LOCALAPPDATA;
  if (localAppData && localAppData.trim().length > 0) {
    return resolve(localAppData);
  }

  return join(app.getPath("home"), "AppData", "Local");
}

function migratePackagedUserDataPath(
  userDataPath: string,
  legacyPaths: string[],
): void {
  if (existsSync(userDataPath)) {
    return;
  }

  for (const oldPath of legacyPaths) {
    if (!existsSync(oldPath)) {
      continue;
    }

    try {
      mkdirSync(dirname(userDataPath), { recursive: true });
      renameSync(oldPath, userDataPath);
      safeWrite(
        process.stdout,
        `[desktop:paths] migrated userData ${oldPath} -> ${userDataPath}\n`,
      );
      return;
    } catch (renameError) {
      const stagingPath = `${userDataPath}.migrating-${process.pid}-${Date.now()}`;

      try {
        cpSync(oldPath, stagingPath, { recursive: true, force: true });
        renameSync(stagingPath, userDataPath);
        safeWrite(
          process.stdout,
          `[desktop:paths] copied userData ${oldPath} -> ${userDataPath}\n`,
        );
        return;
      } catch (copyError) {
        rmSync(stagingPath, { recursive: true, force: true });
        safeWrite(
          process.stderr,
          `[desktop:paths] userData migration failed old=${oldPath} target=${userDataPath} renameError=${String(renameError)} copyError=${String(copyError)}\n`,
        );
      }
    }
  }
}

function configurePackagedPaths(): void {
  if (!app.isPackaged) {
    return;
  }

  const exeDir = dirname(app.getPath("exe"));

  const portable = isPortableMode(exeDir);

  if (portable) {
    configurePortablePaths(exeDir);
    return;
  }

  const appDataPath = app.getPath("appData");
  const localAppDataPath =
    process.platform === "win32" ? getWindowsLocalAppDataPath() : appDataPath;
  const overrideUserDataPath = process.env.NEXU_DESKTOP_USER_DATA_ROOT;
  const defaultUserDataPath = app.getPath("userData");

  const legacyPath = join(appDataPath, "@clawpi", "desktop");
  const legacyWindowsPath = join(appDataPath, "nexu-desktop");
  const roamingWindowsPath = join(appDataPath, "claw-pi-desktop");
  const windowsPath = join(localAppDataPath, "claw-pi-desktop");

  const userDataPath = overrideUserDataPath
    ? resolve(overrideUserDataPath)
    : process.platform === "win32"
      ? windowsPath
      : legacyPath;

  // Windows migration: move mutable runtime/config data out of Roaming AppData.
  // Roaming profile sync and endpoint security often hold files open briefly,
  // which can turn atomic config writes into EPERM failures.
  if (process.platform === "win32" && !overrideUserDataPath) {
    migratePackagedUserDataPath(userDataPath, [
      roamingWindowsPath,
      legacyWindowsPath,
      legacyPath,
    ]);
  }

  const sessionDataPath = join(userDataPath, "session");
  const logsPath = join(userDataPath, "logs");
  const nexuHomePath = getDesktopNexuHomeDir(userDataPath);

  mkdirSync(userDataPath, { recursive: true });
  mkdirSync(sessionDataPath, { recursive: true });
  mkdirSync(logsPath, { recursive: true });
  mkdirSync(nexuHomePath, { recursive: true });

  process.env.NEXU_HOME = nexuHomePath;
  app.setPath("userData", userDataPath);
  app.setPath("sessionData", sessionDataPath);
  app.setAppLogsPath(logsPath);

  safeWrite(
    process.stdout,
    `[desktop:paths] appData=${appDataPath} localAppData=${localAppDataPath} defaultUserData=${defaultUserDataPath} overrideUserData=${overrideUserDataPath ?? "<unset>"} userData=${userDataPath} sessionData=${sessionDataPath} logs=${logsPath} nexuHome=${nexuHomePath}\n`,
  );
}

function configurePortablePaths(exeDir: string): void {
  const dataRoot = getPortableDataRoot(exeDir);
  const userDataPath = join(dataRoot, "user-data");
  const sessionDataPath = join(dataRoot, "session-data");
  const logsPath = join(dataRoot, "logs");
  const nexuHomePath = join(dataRoot, "nexu-home");

  mkdirSync(userDataPath, { recursive: true });
  mkdirSync(sessionDataPath, { recursive: true });
  mkdirSync(logsPath, { recursive: true });
  mkdirSync(nexuHomePath, { recursive: true });

  process.env.NEXU_HOME = nexuHomePath;
  process.env.NEXU_DESKTOP_PORTABLE = "1";
  app.setPath("userData", userDataPath);
  app.setPath("sessionData", sessionDataPath);
  app.setAppLogsPath(logsPath);

  safeWrite(
    process.stdout,
    `[desktop:paths:portable] dataRoot=${dataRoot} userData=${userDataPath} sessionData=${sessionDataPath} logs=${logsPath} nexuHome=${nexuHomePath}\n`,
  );
}

const CHROMIUM_CACHE_DIRS = [
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
];

function clearStaleChromiumCache(): void {
  const userDataPath = app.getPath("userData");
  const stampFile = join(userDataPath, ".version-stamp");
  const currentVersion = app.getVersion();

  try {
    const storedVersion = existsSync(stampFile)
      ? readFileSync(stampFile, "utf-8").trim()
      : null;

    if (storedVersion === currentVersion) {
      return;
    }

    for (const dir of CHROMIUM_CACHE_DIRS) {
      const cachePath = join(userDataPath, dir);
      if (existsSync(cachePath)) {
        try {
          rmSync(cachePath, { recursive: true, force: true });
        } catch {
          // Non-fatal: cache may be locked by another instance.
        }
      }
    }

    writeFileSync(stampFile, currentVersion, "utf-8");

    safeWrite(
      process.stdout,
      `[desktop:cache] cleared stale Chromium caches (${storedVersion ?? "<none>"} → ${currentVersion})\n`,
    );
  } catch {
    // Non-fatal: don't block startup over cache housekeeping.
  }
}

loadDesktopDevEnv();
configurePackagedPaths();
configureLocalDevPaths();
clearStaleChromiumCache();

await import("./index");
