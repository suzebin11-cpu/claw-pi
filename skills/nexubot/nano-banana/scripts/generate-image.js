#!/usr/bin/env node

/**
 * Generate or edit images using Gemini image models.
 * Requires: sharp (npm install sharp)
 *
 * Usage:
 *   node generate-image.js --prompt "a cat on mars" --filename output.png
 *   node generate-image.js --prompt "edit this" --filename out.png -i photo.png --model nano-banana-pro
 *   node generate-image.js --prompt "combine" --filename out.png -i a.png -i b.png -i c.png
 *
 * Models:
 *   nano-banana     → gemini-3.1-flash-image-preview (default, fast)
 *   nano-banana-pro → gemini-3-pro-image-preview (highest quality)
 *   nano-banana-2   → gemini-2.5-flash-image (legacy)
 *
 * Fallback:
 *   If the primary model returns a retryable error (5xx / 408 / 429 / network
 *   error / 200-but-no-image), the script automatically retries using a
 *   fallback chain. This protects against upstream (e.g. yunwu) instability.
 *
 *   Default chains:
 *     nano-banana     → nano-banana-pro
 *     nano-banana-pro → nano-banana
 *     nano-banana-2   → nano-banana → nano-banana-pro
 *
 *   Env vars:
 *     NANO_BANANA_FALLBACK=0            Disable fallback (exit on first error)
 *     NANO_BANANA_FALLBACK_CHAIN=a,b,c  Override the full try order
 *                                       (comma-separated model aliases)
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MODEL_MAP = {
  "nano-banana": "gemini-3.1-flash-image-preview",
  "nano-banana-pro": "gemini-3-pro-image-preview",
  "nano-banana-2": "gemini-2.5-flash-image",
};

const DEFAULT_FALLBACK_CHAINS = {
  "nano-banana": ["nano-banana-pro"],
  "nano-banana-pro": ["nano-banana"],
  "nano-banana-2": ["nano-banana", "nano-banana-pro"],
};

const VALID_MODELS = Object.keys(MODEL_MAP);
const RESOLUTIONS = ["1K", "2K", "4K"];
const MAX_INPUT_IMAGES = 14;
const MAX_IMAGE_BYTES = 512_000; // 500 KB per image after compression

const GENERATE_BASE_URL = "https://api.openlux.ai";

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printHelp() {
  console.log(`Usage: node generate-image.js --prompt "desc" --filename "out.png" [options]

Options:
  -p, --prompt        Image description / editing instruction (required)
  -f, --filename      Output filename (required)
  -i, --input-image   Input image path(s) for editing (repeatable, max 14)
      --model         Model: nano-banana (default), nano-banana-pro, nano-banana-2
  -r, --resolution    Output resolution: 1K (default), 2K, 4K
      --aspect-ratio  Aspect ratio e.g. 1:1, 16:9, 4:3, 3:4, 9:16
  -h, --help          Show this help`);
}

function parseCliArgs() {
  const { values } = parseArgs({
    options: {
      prompt: { type: "string", short: "p" },
      filename: { type: "string", short: "f" },
      "input-image": { type: "string", short: "i", multiple: true },
      model: { type: "string", default: "nano-banana" },
      resolution: { type: "string", short: "r", default: "1K" },
      "aspect-ratio": { type: "string" },
      help: { type: "boolean", short: "h" },
    },
    strict: true,
  });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  if (!values.prompt) {
    console.error("Error: --prompt is required");
    process.exit(1);
  }
  if (!values.filename) {
    console.error("Error: --filename is required");
    process.exit(1);
  }
  if (!VALID_MODELS.includes(values.model)) {
    console.error(`Error: --model must be one of: ${VALID_MODELS.join(", ")}`);
    process.exit(1);
  }
  if (!RESOLUTIONS.includes(values.resolution)) {
    console.error(
      `Error: --resolution must be one of: ${RESOLUTIONS.join(", ")}`,
    );
    process.exit(1);
  }

  const inputImages = values["input-image"] || [];
  if (inputImages.length > MAX_INPUT_IMAGES) {
    console.error(
      `Error: Too many input images (${inputImages.length}). Maximum is ${MAX_INPUT_IMAGES}.`,
    );
    process.exit(1);
  }

  return {
    prompt: values.prompt,
    filename: values.filename,
    inputImages,
    model: values.model,
    resolution: values.resolution,
    aspectRatio: values["aspect-ratio"] ?? undefined,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function resolveContextFile() {
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);

  if (process.env.OPENCLAW_STATE_DIR) {
    const p = path.join(process.env.OPENCLAW_STATE_DIR, "nexu-context.json");
    if (fs.existsSync(p)) return p;
  }

  // Walk up from script dir: scripts/ → nano-banana/ → skills/ → stateDir/
  const stateDir = path.dirname(path.dirname(path.dirname(scriptDir)));
  const p = path.join(stateDir, "nexu-context.json");
  if (fs.existsSync(p)) return p;

  return null;
}

async function fetchApiKey() {
  // Tier 1: environment variable
  if (process.env.GEMINI_API_KEY) {
    return process.env.GEMINI_API_KEY;
  }

  // Tier 2: Nexu secrets API via SKILL_API_TOKEN + nexu-context.json
  const token = process.env.SKILL_API_TOKEN;
  const contextFile = resolveContextFile();

  if (token && contextFile) {
    try {
      const ctx = JSON.parse(fs.readFileSync(contextFile, "utf-8"));
      const { apiUrl, poolId } = ctx;
      if (apiUrl && poolId) {
        const url = `${apiUrl}/api/internal/secrets/nano-banana?poolId=${poolId}`;
        const res = await fetch(url, {
          headers: { "x-internal-token": token },
        });
        if (res.ok) {
          const secrets = await res.json();
          if (secrets.GEMINI_API_KEY) {
            return secrets.GEMINI_API_KEY;
          }
        }
      }
    } catch (err) {
      console.error(
        `Warning: Failed to fetch secret from Nexu API: ${err.message}`,
      );
    }
  }

  console.error(
    "Error: GEMINI_API_KEY not found.\n" +
      "Set it via:\n" +
      "  1. GEMINI_API_KEY environment variable, or\n" +
      "  2. Nexu pool secrets API (requires SKILL_API_TOKEN + nexu-context.json)",
  );
  process.exit(1);
}

function mimeType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".jpg" || ext === ".jpeg") return "image/jpeg";
  if (ext === ".webp") return "image/webp";
  if (ext === ".gif") return "image/gif";
  return "image/png";
}

// ---------------------------------------------------------------------------
// Image compression via sharp
// ---------------------------------------------------------------------------

// Use createRequire so NODE_PATH resolves globally-installed sharp
// (works in sandbox without a /node_modules symlink).
import { createRequire } from "node:module";
const _require = createRequire(import.meta.url);

let sharp;
try {
  sharp = _require("sharp");
} catch {
  // Not pre-installed — try auto-install (works outside sandbox where fs is writable).
  const { execSync } = await import("node:child_process");
  const scriptDir = path.dirname(new URL(import.meta.url).pathname);
  console.log("Installing sharp (first run only)...");
  try {
    execSync("npm install --no-save sharp", {
      cwd: scriptDir,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 60_000,
    });
    sharp = _require("sharp");
  } catch {
    console.error("ERROR: sharp is required but could not be installed.");
    process.exit(1);
  }
}

async function compressImage(buffer, maxBytes) {
  if (buffer.length <= maxBytes) {
    return buffer;
  }

  // Progressive JPEG quality reduction
  let quality = 85;
  let output = await sharp(buffer).jpeg({ quality }).toBuffer();

  while (output.length > maxBytes && quality > 10) {
    quality -= 10;
    output = await sharp(buffer).jpeg({ quality }).toBuffer();
  }

  // If still over limit, also resize dimensions
  if (output.length > maxBytes) {
    const meta = await sharp(buffer).metadata();
    if (meta.width) {
      const scale = Math.sqrt(maxBytes / output.length) * 0.9;
      const newWidth = Math.max(256, Math.round(meta.width * scale));
      output = await sharp(buffer)
        .resize(newWidth)
        .jpeg({ quality: Math.max(quality, 20) })
        .toBuffer();
    }
  }

  return output;
}

// ---------------------------------------------------------------------------
// Build request parts for input images (always inline base64)
// ---------------------------------------------------------------------------

async function buildImageParts(imagePaths) {
  if (imagePaths.length === 0) return [];

  const parts = [];
  for (const p of imagePaths) {
    const resolved = path.resolve(p);
    let buffer;
    try {
      buffer = fs.readFileSync(resolved);
    } catch (e) {
      console.error(`Error loading image '${resolved}': ${e.message}`);
      process.exit(1);
    }

    const originalSize = buffer.length;
    const compressed = await compressImage(buffer, MAX_IMAGE_BYTES);
    const mime = compressed === buffer ? mimeType(resolved) : "image/jpeg";

    if (compressed !== buffer) {
      console.log(
        `  Compressed ${path.basename(resolved)}: ${Math.round(originalSize / 1024)}KB → ${Math.round(compressed.length / 1024)}KB`,
      );
    }

    parts.push({
      inline_data: {
        data: compressed.toString("base64"),
        mime_type: mime,
      },
    });
  }

  console.log(`Prepared ${parts.length} image(s) as inline base64`);
  return parts;
}

// ---------------------------------------------------------------------------
// Generate
// ---------------------------------------------------------------------------

function resolveOutputPath(filename) {
  // Absolute paths are used as-is; relative filenames go under
  // ~/.openclaw/workspace/output/nano-banana/ which is an allowed media root
  // (stateDir/workspace is in the default media local roots list).
  if (path.isAbsolute(filename)) return filename;

  const stateDir =
    process.env.OPENCLAW_STATE_DIR ||
    path.join(process.env.HOME || process.env.USERPROFILE || "~", ".openclaw");
  return path.join(
    stateDir,
    "media",
    "outbound",
    path.basename(process.cwd()),
    "nano-banana",
    filename,
  );
}

function isRetryableStatus(status) {
  // Retry on server-side hiccups, timeout, rate limit. 4xx (400/401/403/404)
  // almost always means the request itself is wrong — fallback won't help.
  if (status >= 500) return true;
  if (status === 408 || status === 429) return true;
  return false;
}

function resolveFallbackChain(primaryAlias) {
  const override = process.env.NANO_BANANA_FALLBACK_CHAIN;
  if (override && override.trim().length > 0) {
    const chain = override
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    const unknown = chain.find((alias) => !VALID_MODELS.includes(alias));
    if (unknown) {
      console.error(
        `Warning: NANO_BANANA_FALLBACK_CHAIN contains unknown model '${unknown}', ignoring override.`,
      );
    } else if (chain.length > 0) {
      return chain;
    }
  }

  const flag = (process.env.NANO_BANANA_FALLBACK || "").toLowerCase();
  if (flag === "0" || flag === "off" || flag === "false" || flag === "no") {
    return [primaryAlias];
  }

  const fallbacks = DEFAULT_FALLBACK_CHAINS[primaryAlias] ?? [];
  return [primaryAlias, ...fallbacks];
}

async function callModelOnce({
  alias,
  body,
  apiKey,
  attemptLabel,
  imagePartCount,
  resolution,
}) {
  const modelId = MODEL_MAP[alias];
  const url = `${GENERATE_BASE_URL}/v1beta/models/${modelId}:generateContent?key=${apiKey}`;

  if (imagePartCount > 0) {
    console.log(
      `[${attemptLabel}] Processing ${imagePartCount} image(s) with model=${alias} (${modelId}) resolution=${resolution}...`,
    );
  } else {
    console.log(
      `[${attemptLabel}] Generating image with model=${alias} (${modelId}) resolution=${resolution}...`,
    );
  }

  const started = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${attemptLabel}] Network error: ${message}`);
    return { kind: "retryable", reason: `network: ${message}` };
  }

  const elapsedMs = Date.now() - started;

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const snippet = text.slice(0, 800);
    if (isRetryableStatus(res.status)) {
      console.error(
        `[${attemptLabel}] Retryable API error ${res.status} in ${elapsedMs}ms: ${snippet}`,
      );
      return {
        kind: "retryable",
        reason: `http ${res.status}: ${snippet}`,
      };
    }
    console.error(
      `[${attemptLabel}] Non-retryable API error ${res.status} in ${elapsedMs}ms: ${snippet}`,
    );
    return {
      kind: "fatal",
      reason: `http ${res.status}: ${snippet}`,
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(
      `[${attemptLabel}] Invalid JSON response in ${elapsedMs}ms: ${message}`,
    );
    return { kind: "retryable", reason: `invalid json: ${message}` };
  }

  const parts = data?.candidates?.[0]?.content?.parts ?? [];
  const imagePart = parts.find((p) => p?.inlineData?.data);
  const textParts = parts.filter((p) => p?.text).map((p) => p.text);

  if (!imagePart) {
    const finishReason = data?.candidates?.[0]?.finishReason ?? "unknown";
    const textSummary = textParts.join(" ").slice(0, 300);
    console.error(
      `[${attemptLabel}] 200 OK but no image (finishReason=${finishReason}) in ${elapsedMs}ms${
        textSummary ? ` — text: ${textSummary}` : ""
      }`,
    );
    return {
      kind: "retryable",
      reason: `no image (finishReason=${finishReason})`,
    };
  }

  return {
    kind: "ok",
    elapsedMs,
    imagePart,
    textParts,
  };
}

async function generateImage(args, apiKey) {
  const imageParts = await buildImageParts(args.inputImages);

  const contents = [
    {
      role: "user",
      parts: [...imageParts, { text: args.prompt }],
    },
  ];

  const imageConfig = { imageSize: args.resolution };
  if (args.aspectRatio) {
    imageConfig.aspectRatio = args.aspectRatio;
  }

  const body = {
    contents,
    generationConfig: {
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig,
    },
  };

  const chain = resolveFallbackChain(args.model);
  if (chain.length > 1) {
    console.log(`Fallback chain (primary → fallbacks): ${chain.join(" → ")}`);
  }

  const failures = [];
  let success = null;
  let usedAlias = null;

  for (let i = 0; i < chain.length; i++) {
    const alias = chain[i];
    const attemptLabel = `attempt ${i + 1}/${chain.length}`;

    const result = await callModelOnce({
      alias,
      body,
      apiKey,
      attemptLabel,
      imagePartCount: imageParts.length,
      resolution: args.resolution,
    });

    if (result.kind === "ok") {
      success = result;
      usedAlias = alias;
      break;
    }

    failures.push({ alias, kind: result.kind, reason: result.reason });

    if (result.kind === "fatal") {
      // Request/auth/shape problem: fallback won't help.
      break;
    }
  }

  if (!success) {
    console.error(
      `Error: Image generation failed after ${failures.length} attempt(s).`,
    );
    for (const f of failures) {
      console.error(`  - ${f.alias} [${f.kind}]: ${f.reason}`);
    }
    process.exit(1);
  }

  const outputPath = resolveOutputPath(args.filename);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });

  const imageData = Buffer.from(success.imagePart.inlineData.data, "base64");
  fs.writeFileSync(outputPath, imageData);

  for (const text of success.textParts) {
    console.log(`Model: ${text}`);
  }

  if (!fs.existsSync(outputPath)) {
    console.error(`Error: File was written but not found at ${outputPath}`);
    process.exit(1);
  }

  const stat = fs.statSync(outputPath);
  if (usedAlias !== args.model) {
    console.log(
      `Note: primary model '${args.model}' failed, succeeded via fallback '${usedAlias}'.`,
    );
  }
  console.log(`Image saved: ${outputPath} (${Math.round(stat.size / 1024)}KB)`);
  console.log(`MEDIA: ${outputPath}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = parseCliArgs();
const apiKey = await fetchApiKey();
await generateImage(args, apiKey);
