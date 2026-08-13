#!/usr/bin/env node
/**
 * OpenAI-compatible image generation CLI.
 *
 * Default endpoint: https://api.openlux.ai/v1/images/generations
 * Default model:    gpt-image-2-all
 *
 * Works with any OpenAI-compatible image endpoint (gpt-image-1, gpt-image-1.5,
 * gpt-image-2-all, dall-e-3, sora_image, gpt-4o-image-vip, ...). Override
 * upstream with --base-url.
 *
 * Usage:
 *   node yunwu-image.mjs -p "a corgi on mars"
 *   node yunwu-image.mjs --prompt-file ./p.txt -o out.png -m gpt-image-2-all -s 1536x1024
 *   echo "a corgi" | node yunwu-image.mjs -o out.png
 *   node yunwu-image.mjs -p "..." -n 4 -o batch.png      # → batch-1.png ... batch-4.png
 *
 * Auth (in order of precedence):
 *   1. --api-key
 *   2. env YUNWU_API_KEY
 *   3. env OPENAI_API_KEY
 */

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";

const HELP = `OpenAI-compatible image generation CLI (default: api.openlux.ai).

Usage:
  node yunwu-image.mjs -p "prompt" -o out.png
  node yunwu-image.mjs --prompt-file p.txt -m gpt-image-2-all -s 1536x1024
  echo "prompt" | node yunwu-image.mjs -o out.png

Options:
  -p, --prompt          prompt text (or use --prompt-file or stdin)
      --prompt-file     read prompt from a file
  -o, --output          output path (default ./image-<ts>.png; -1/-2/... when n>1)
  -n, --num             how many images, default 1
  -m, --model           model id, default gpt-image-2-all
  -s, --size            size, default 1024x1024 (e.g. 1024x1024, 1536x1024, 1024x1536)
      --base-url        API base, default https://api.openlux.ai
      --endpoint        endpoint path, default /v1/images/generations
      --api-key         API key (overrides env OPENLUX_API_KEY / YUNWU_API_KEY / OPENAI_API_KEY)
      --extra           extra JSON merged into request body, e.g. '{"quality":"hd"}'
      --timeout         request timeout in seconds, default 300
      --quiet           suppress progress logs
  -h, --help
`;

// ---------------------------------------------------------------------------
// Parse args
// ---------------------------------------------------------------------------

let parsed;
try {
  parsed = parseArgs({
    options: {
      prompt: { type: "string", short: "p" },
      "prompt-file": { type: "string" },
      output: { type: "string", short: "o" },
      num: { type: "string", short: "n", default: "1" },
      model: { type: "string", short: "m", default: "gpt-image-2-all" },
      size: { type: "string", short: "s", default: "1024x1024" },
      "base-url": { type: "string", default: "https://api.openlux.ai" },
      endpoint: { type: "string", default: "/v1/images/generations" },
      "api-key": { type: "string" },
      extra: { type: "string" },
      timeout: { type: "string", default: "300" },
      quiet: { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
    strict: true,
  });
} catch (err) {
  console.error(`Error: ${err.message}\n\n${HELP}`);
  process.exit(2);
}
const { values } = parsed;

if (values.help) {
  console.log(HELP);
  process.exit(0);
}

const log = values.quiet ? () => {} : (...a) => console.log(...a);

// ---------------------------------------------------------------------------
// Resolve prompt
// ---------------------------------------------------------------------------

async function readStdin() {
  if (process.stdin.isTTY) return null;
  let s = "";
  for await (const chunk of process.stdin) s += chunk;
  s = s.trim();
  return s.length > 0 ? s : null;
}

let prompt = values.prompt;
if (!prompt && values["prompt-file"]) {
  try {
    prompt = fs.readFileSync(values["prompt-file"], "utf8");
  } catch (err) {
    console.error(`Error: cannot read --prompt-file: ${err.message}`);
    process.exit(2);
  }
}
if (!prompt) prompt = await readStdin();
if (!prompt || !prompt.trim()) {
  console.error("Error: no prompt. Use --prompt, --prompt-file, or pipe via stdin.\n\n" + HELP);
  process.exit(2);
}
prompt = prompt.trim();

// ---------------------------------------------------------------------------
// Resolve API key
// ---------------------------------------------------------------------------

const apiKey =
  values["api-key"] ||
  process.env.OPENLUX_API_KEY ||
  process.env.YUNWU_API_KEY ||
  process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error(
    "Error: missing API key. Pass --api-key or set OPENLUX_API_KEY / YUNWU_API_KEY / OPENAI_API_KEY.",
  );
  process.exit(2);
}

// ---------------------------------------------------------------------------
// Build request
// ---------------------------------------------------------------------------

const n = Math.max(1, Number.parseInt(values.num, 10) || 1);
const timeoutMs = Math.max(1, Number.parseInt(values.timeout, 10) || 300) * 1000;
const baseUrl = values["base-url"].replace(/\/+$/, "");
const ep = values.endpoint.startsWith("/") ? values.endpoint : `/${values.endpoint}`;
const url = `${baseUrl}${ep}`;

let body = {
  model: values.model,
  prompt,
  n,
  size: values.size,
};

if (values.extra) {
  let extraObj;
  try {
    extraObj = JSON.parse(values.extra);
  } catch (err) {
    console.error(`Error: --extra is not valid JSON: ${err.message}`);
    process.exit(2);
  }
  if (extraObj && typeof extraObj === "object" && !Array.isArray(extraObj)) {
    body = { ...body, ...extraObj };
  } else {
    console.error("Error: --extra must be a JSON object.");
    process.exit(2);
  }
}

// ---------------------------------------------------------------------------
// Output planner
// ---------------------------------------------------------------------------

const ts = new Date()
  .toISOString()
  .replace(/[:.]/g, "-")
  .replace("T", "_")
  .slice(0, 19);
const baseOutput = values.output || `./image-${ts}.png`;

function outputFor(idx, total) {
  const resolved = path.resolve(baseOutput);
  if (total === 1) return resolved;
  const ext = path.extname(resolved) || ".png";
  const stem = resolved.slice(0, resolved.length - ext.length);
  return `${stem}-${idx + 1}${ext}`;
}

// ---------------------------------------------------------------------------
// Call API
// ---------------------------------------------------------------------------

log(`POST ${url}`);
log(`  model=${values.model}  size=${values.size}  n=${n}  prompt.len=${prompt.length}`);

const ac = new AbortController();
const timer = setTimeout(() => ac.abort(), timeoutMs);
const t0 = Date.now();

let res;
try {
  res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: ac.signal,
  });
} catch (err) {
  clearTimeout(timer);
  const msg = err?.name === "AbortError"
    ? `request timeout after ${timeoutMs / 1000}s`
    : `network error: ${err?.message || err}`;
  console.error(msg);
  process.exit(1);
}
clearTimeout(timer);
const elapsed = Date.now() - t0;
log(`  status=${res.status} in ${elapsed}ms`);

const text = await res.text();
let data;
try {
  data = JSON.parse(text);
} catch {
  console.error(`Non-JSON response (first 2KB):\n${text.slice(0, 2048)}`);
  process.exit(1);
}

if (!res.ok || data.error) {
  console.error(`API error:\n${JSON.stringify(data, null, 2).slice(0, 4000)}`);
  process.exit(1);
}

const items = data?.data;
if (!Array.isArray(items) || items.length === 0) {
  console.error(`No data[]; full response:\n${JSON.stringify(data).slice(0, 2000)}`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Save
// ---------------------------------------------------------------------------

let saved = 0;
for (let i = 0; i < items.length; i++) {
  const item = items[i];
  let buf;
  if (item.b64_json) {
    buf = Buffer.from(item.b64_json, "base64");
  } else if (item.url) {
    log(`  [${i + 1}/${items.length}] downloading ${item.url.slice(0, 90)}...`);
    let r2;
    try {
      r2 = await fetch(item.url);
    } catch (err) {
      console.error(`  [${i + 1}/${items.length}] download error: ${err?.message || err}`);
      continue;
    }
    if (!r2.ok) {
      console.error(`  [${i + 1}/${items.length}] download status ${r2.status}`);
      continue;
    }
    buf = Buffer.from(await r2.arrayBuffer());
  } else {
    console.error(
      `  [${i + 1}/${items.length}] unknown item shape: ${JSON.stringify(item).slice(0, 400)}`,
    );
    continue;
  }

  const out = outputFor(i, items.length);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, buf);
  saved++;
  log(
    `  [${i + 1}/${items.length}] saved ${out}  (${Math.round(buf.length / 1024)} KB)`,
  );
  if (item.revised_prompt) {
    const rp = String(item.revised_prompt);
    log(`      revised_prompt: ${rp.slice(0, 200)}${rp.length > 200 ? "…" : ""}`);
  }
}

if (saved === 0) {
  console.error("Failed: 0 images saved.");
  process.exit(1);
}
log(`Done: ${saved}/${items.length} saved.`);
