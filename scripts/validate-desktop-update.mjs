import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "yaml";

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function parseManifest(text, source) {
  const manifest = parse(text);
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error(`${source} is not a valid update manifest.`);
  }
  return manifest;
}

function getManifestFiles(manifest) {
  const rawFiles =
    Array.isArray(manifest.files) && manifest.files.length > 0
      ? manifest.files
      : manifest.path
        ? [{ url: manifest.path, sha512: manifest.sha512 }]
        : [];

  if (rawFiles.length === 0) {
    throw new Error("Update manifest does not reference any files.");
  }

  return rawFiles.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`Manifest files[${index}] must be an object.`);
    }

    const url = requireString(entry.url, `Manifest files[${index}].url`);
    const fileName = basename(
      decodeURIComponent(new URL(url, "https://updates.invalid/").pathname),
    );
    if (!fileName) {
      throw new Error(`Manifest files[${index}].url has no file name.`);
    }

    return {
      fileName,
      sha512:
        typeof entry.sha512 === "string" && entry.sha512.trim()
          ? entry.sha512.trim()
          : null,
      size:
        typeof entry.size === "number" && Number.isFinite(entry.size)
          ? entry.size
          : null,
      url,
    };
  });
}

function resolveArtifactPath(artifactDir, fileName) {
  if (isAbsolute(fileName)) {
    throw new Error(`Artifact name must be relative: ${fileName}`);
  }

  const root = resolve(artifactDir);
  const artifactPath = resolve(root, fileName);
  const artifactRelative = relative(root, artifactPath);
  if (
    artifactRelative === ".." ||
    artifactRelative.startsWith("..\\") ||
    artifactRelative.startsWith("../")
  ) {
    throw new Error(`Artifact escapes its release directory: ${fileName}`);
  }
  return artifactPath;
}

async function assertLocalFile(artifactDir, fileName) {
  const artifactPath = resolveArtifactPath(artifactDir, fileName);
  const details = await stat(artifactPath).catch(() => null);
  if (!details?.isFile() || details.size <= 0) {
    throw new Error(`Missing or empty release artifact: ${artifactPath}`);
  }
  return { artifactPath, size: details.size };
}

export async function validateLocalRelease({
  artifactDir,
  expectedVersion,
  manifestPath,
  requiredFiles = [],
}) {
  const manifest = parseManifest(
    await readFile(manifestPath, "utf8"),
    manifestPath,
  );
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Manifest version ${String(manifest.version)} does not match ${expectedVersion}.`,
    );
  }

  const manifestFiles = getManifestFiles(manifest);
  for (const entry of manifestFiles) {
    const { artifactPath, size } = await assertLocalFile(
      artifactDir,
      entry.fileName,
    );
    if (entry.size !== null && entry.size !== size) {
      throw new Error(
        `Manifest size for ${entry.fileName} is ${entry.size}, actual size is ${size}.`,
      );
    }
    if (entry.sha512) {
      const digest = createHash("sha512")
        .update(await readFile(artifactPath))
        .digest("base64");
      if (digest !== entry.sha512) {
        throw new Error(`SHA-512 mismatch for ${entry.fileName}.`);
      }
    }
  }

  for (const fileName of requiredFiles) {
    await assertLocalFile(artifactDir, fileName);
  }

  return {
    files: manifestFiles.map((entry) => entry.fileName),
    version: manifest.version,
  };
}

function withCacheBuster(url, attempt) {
  const output = new URL(url);
  output.searchParams.set("release_check", `${Date.now()}-${attempt}`);
  return output;
}

async function probeRemoteArtifact(url) {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Range: "bytes=0-0" },
    redirect: "follow",
  });
  await response.body?.cancel();
  if (response.status !== 200 && response.status !== 206) {
    throw new Error(`Remote artifact returned HTTP ${response.status}: ${url}`);
  }
}

async function validateRemoteAttempt({
  attempt,
  expectedVersion,
  feedUrl,
  manifestName,
  requiredFiles,
}) {
  const baseUrl = new URL(feedUrl.endsWith("/") ? feedUrl : `${feedUrl}/`);
  const manifestUrl = new URL(manifestName, baseUrl);
  const response = await fetch(withCacheBuster(manifestUrl, attempt), {
    cache: "no-store",
    redirect: "follow",
  });
  if (!response.ok) {
    throw new Error(
      `Remote manifest returned HTTP ${response.status}: ${manifestUrl}`,
    );
  }

  const manifest = parseManifest(await response.text(), manifestUrl.toString());
  if (manifest.version !== expectedVersion) {
    throw new Error(
      `Remote manifest version ${String(manifest.version)} does not match ${expectedVersion}.`,
    );
  }

  const manifestFiles = getManifestFiles(manifest);
  const urls = new Map();
  for (const entry of manifestFiles) {
    urls.set(entry.fileName, new URL(entry.url, baseUrl));
  }
  for (const fileName of requiredFiles) {
    urls.set(fileName, new URL(fileName, baseUrl));
  }

  for (const [fileName, url] of urls) {
    await probeRemoteArtifact(url);
    console.log(`[update-validate] remote artifact ready: ${fileName}`);
  }

  return {
    files: [...urls.keys()],
    version: manifest.version,
  };
}

export async function validateRemoteRelease({
  attempts = 12,
  delayMs = 5_000,
  expectedVersion,
  feedUrl,
  manifestName,
  requiredFiles = [],
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await validateRemoteAttempt({
        attempt,
        expectedVersion,
        feedUrl,
        manifestName,
        requiredFiles,
      });
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
      console.warn(
        `[update-validate] attempt ${attempt}/${attempts} failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delayMs));
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("Remote update validation failed.");
}

function parseCliArgs(argv) {
  const options = { requiredFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    const value = argv[index + 1];
    if (name === "--required") {
      options.requiredFiles.push(requireString(value, "--required"));
      index += 1;
    } else if (name?.startsWith("--")) {
      options[name.slice(2)] = requireString(value, name);
      index += 1;
    } else {
      throw new Error(`Unexpected argument: ${name}`);
    }
  }
  return options;
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  const expectedVersion = requireString(options.version, "--version");

  if (options.manifest) {
    const result = await validateLocalRelease({
      artifactDir: requireString(options["artifact-dir"], "--artifact-dir"),
      expectedVersion,
      manifestPath: options.manifest,
      requiredFiles: options.requiredFiles,
    });
    console.log(
      `[update-validate] local release ${result.version} is complete (${result.files.join(", ")}).`,
    );
    return;
  }

  const result = await validateRemoteRelease({
    attempts: options.attempts ? Number(options.attempts) : undefined,
    delayMs: options["delay-ms"] ? Number(options["delay-ms"]) : undefined,
    expectedVersion,
    feedUrl: requireString(options["feed-url"], "--feed-url"),
    manifestName: requireString(options["manifest-name"], "--manifest-name"),
    requiredFiles: options.requiredFiles,
  });
  console.log(
    `[update-validate] remote release ${result.version} is ready (${result.files.join(", ")}).`,
  );
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch((error) => {
    console.error(
      `[update-validate] ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exitCode = 1;
  });
}
