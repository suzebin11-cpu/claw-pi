import { createHash } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { type Server, createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  validateLocalRelease,
  validateRemoteRelease,
} from "../../scripts/validate-desktop-update.mjs";

const cleanupPaths: string[] = [];
const servers: Server[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
        }),
    ),
  );
  await Promise.all(
    cleanupPaths
      .splice(0)
      .map((path) => rm(path, { force: true, recursive: true })),
  );
});

async function createFixture() {
  const root = await mkdtemp(join(tmpdir(), "desktop-update-"));
  cleanupPaths.push(root);
  const artifactDir = join(root, "artifacts");
  await mkdir(artifactDir);

  const fileName = "claw-pi-setup-1.2.3-x64.exe";
  const content = Buffer.from("signed installer");
  await writeFile(join(artifactDir, fileName), content);
  await writeFile(join(artifactDir, `${fileName}.blockmap`), "blockmap");
  await writeFile(join(artifactDir, "desktop-win-x64-sha256.txt"), "checksum");

  const manifest = stringify({
    version: "1.2.3",
    files: [
      {
        url: fileName,
        sha512: createHash("sha512").update(content).digest("base64"),
        size: content.length,
      },
    ],
    path: fileName,
    sha512: createHash("sha512").update(content).digest("base64"),
  });
  const manifestPath = join(artifactDir, "latest.yml");
  await writeFile(manifestPath, manifest);

  return { artifactDir, fileName, manifest, manifestPath };
}

describe("desktop update artifact validator", () => {
  it("validates manifest metadata, hashes, and required local artifacts", async () => {
    const fixture = await createFixture();

    await expect(
      validateLocalRelease({
        artifactDir: fixture.artifactDir,
        expectedVersion: "1.2.3",
        manifestPath: fixture.manifestPath,
        requiredFiles: [
          `${fixture.fileName}.blockmap`,
          "desktop-win-x64-sha256.txt",
        ],
      }),
    ).resolves.toMatchObject({ version: "1.2.3" });
  });

  it("rejects an incomplete local release", async () => {
    const fixture = await createFixture();

    await expect(
      validateLocalRelease({
        artifactDir: fixture.artifactDir,
        expectedVersion: "1.2.3",
        manifestPath: fixture.manifestPath,
        requiredFiles: ["missing.blockmap"],
      }),
    ).rejects.toThrow("Missing or empty release artifact");
  });

  it("validates a published manifest and every remote artifact", async () => {
    const fixture = await createFixture();
    const routes = new Map<string, string | Buffer>([
      ["/latest.yml", fixture.manifest],
      [`/${fixture.fileName}`, Buffer.from("signed installer")],
      [`/${fixture.fileName}.blockmap`, "blockmap"],
    ]);
    const server = createServer((request, response) => {
      const pathname = new URL(request.url ?? "/", "http://localhost").pathname;
      const body = routes.get(pathname);
      if (body === undefined) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(request.headers.range ? 206 : 200, {
        "Content-Type": pathname.endsWith(".yml")
          ? "text/yaml"
          : "application/octet-stream",
      });
      response.end(
        request.headers.range ? Buffer.from(body).subarray(0, 1) : body,
      );
    });
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Test server did not expose a TCP port.");
    }

    await expect(
      validateRemoteRelease({
        attempts: 1,
        delayMs: 0,
        expectedVersion: "1.2.3",
        feedUrl: `http://127.0.0.1:${address.port}`,
        manifestName: "latest.yml",
        requiredFiles: [`${fixture.fileName}.blockmap`],
      }),
    ).resolves.toMatchObject({ version: "1.2.3" });
  });
});
