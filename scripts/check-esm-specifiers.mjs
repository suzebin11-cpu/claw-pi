import { readFile, readdir } from "node:fs/promises";
import { extname, join, relative } from "node:path";
import { init, parse } from "es-module-lexer";

const repoRoot = process.cwd();
const targets = ["apps/controller/dist"];
const allowedExtensions = new Set([".js", ".mjs", ".cjs", ".json", ".node"]);
const jsFileExtensions = new Set([".js", ".mjs", ".cjs"]);

async function walkFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const nextPath = join(dirPath, entry.name);
    if (entry.isDirectory()) {
      const childFiles = await walkFiles(nextPath);
      files.push(...childFiles);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (jsFileExtensions.has(extname(entry.name))) {
      files.push(nextPath);
    }
  }

  return files;
}

function isRelativeSpecifier(specifier) {
  return specifier.startsWith("./") || specifier.startsWith("../");
}

function hasAllowedExtension(specifier) {
  const withoutQuery = specifier.split("?")[0];
  const withoutHash = withoutQuery.split("#")[0];
  const extension = extname(withoutHash);
  return allowedExtensions.has(extension);
}

async function collectMissingExtensions(fileContent) {
  const missing = [];

  const [imports] = parse(fileContent);
  for (const entry of imports) {
    const specifier = fileContent.slice(entry.s, entry.e);
    if (!specifier || !isRelativeSpecifier(specifier)) {
      continue;
    }

    if (hasAllowedExtension(specifier)) {
      continue;
    }

    missing.push(specifier);
  }

  return missing;
}

async function main() {
  await init;
  const violations = [];

  for (const target of targets) {
    const distPath = join(repoRoot, target);

    let files = [];
    try {
      files = await walkFiles(distPath);
    } catch {
      continue;
    }

    for (const filePath of files) {
      const source = await readFile(filePath, "utf8");
      const missingSpecifiers = await collectMissingExtensions(source);

      if (missingSpecifiers.length === 0) {
        continue;
      }

      const uniqueSpecifiers = [...new Set(missingSpecifiers)];
      violations.push({
        filePath,
        specifiers: uniqueSpecifiers,
      });
    }
  }

  if (violations.length === 0) {
    console.log("ESM import specifier check passed.");
    return;
  }

  console.error("Found relative ESM imports without explicit file extensions:");
  for (const violation of violations) {
    console.error(`- ${relative(repoRoot, violation.filePath)}`);
    for (const specifier of violation.specifiers) {
      console.error(`  - ${specifier}`);
    }
  }

  process.exitCode = 1;
}

await main();
