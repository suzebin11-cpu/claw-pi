/**
 * Generate the USB quick-start PDF from the HTML source.
 *
 * Usage:   node scripts/generate-usb-pdf.mjs
 * Output:  docs/zh/guide/Claw-Pi-快速入门指南.pdf
 *
 * Uses system Edge (--headless --print-to-pdf). No extra dependencies needed.
 * Falls back to Chrome if Edge is not found.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { pathToFileURL } from "node:url";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const htmlPath = resolve(repoRoot, "docs/zh/guide/usb-quickstart.html");
const pdfPath = resolve(repoRoot, "docs/zh/guide/Claw-Pi-快速入门指南.pdf");

const edgePaths = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];
const chromePaths = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
];

const browserExe = [...edgePaths, ...chromePaths].find((p) => existsSync(p));

if (!browserExe) {
  console.error(
    "No Edge or Chrome found. Please open the HTML file in a browser and print to PDF manually:",
  );
  console.error(`  file: ${htmlPath}`);
  process.exit(1);
}

const fileUrl = pathToFileURL(htmlPath).href;

console.log(`Browser: ${browserExe}`);
console.log(`Input:   ${htmlPath}`);
console.log(`Output:  ${pdfPath}`);

execFileSync(
  browserExe,
  [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-pdf-header-footer",
    `--print-to-pdf=${pdfPath}`,
    "--print-to-pdf-no-header",
    "--run-all-compositor-stages-before-draw",
    fileUrl,
  ],
  { stdio: "inherit", timeout: 30_000 },
);

console.log(`\nPDF generated: ${pdfPath}`);
