import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function isPortableMode(exeDir: string): boolean {
  return existsSync(join(exeDir, ".portable"));
}

export function getPortableDataRoot(exeDir: string): string {
  return join(exeDir, "data");
}

export function getDesktopNexuHomeDir(userDataPath: string): string {
  return resolve(userDataPath, ".claw-pi");
}

export function getOpenclawSkillsDir(userDataPath: string): string {
  return resolve(userDataPath, "runtime/openclaw/state/skills");
}

export function getSkillhubCacheDir(userDataPath: string): string {
  return resolve(userDataPath, "runtime/skillhub-cache");
}
