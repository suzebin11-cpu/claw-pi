import { createHash, createHmac } from "node:crypto";
import { open, readFile, stat } from "node:fs/promises";
import { basename, resolve } from "node:path";

const DEFAULT_BUCKET = "nexu-desktop-releases";
const MULTIPART_THRESHOLD = 64 * 1024 * 1024;
const PART_SIZE = 64 * 1024 * 1024;
const REGION = "auto";
const SERVICE = "s3";

function fail(message) {
  throw new Error(`[r2] ${message}`);
}

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      fail(`unexpected argument: ${value}`);
    }
    const name = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith("--")) {
      fail(`missing value for --${name}`);
    }
    args[name] = next;
    index += 1;
  }
  return args;
}

function encode(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );
}

function canonicalUri(key) {
  return `/${key.split("/").map((segment) => encode(segment)).join("/")}`;
}

function canonicalQuery(query) {
  return [...query.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const keyOrder = encode(leftKey).localeCompare(encode(rightKey));
      return keyOrder || encode(leftValue).localeCompare(encode(rightValue));
    })
    .map(([key, value]) => `${encode(key)}=${encode(value)}`)
    .join("&");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function hmac(key, value) {
  return createHmac("sha256", key).update(value).digest();
}

function signingKey(secret, date) {
  const dateKey = hmac(`AWS4${secret}`, date);
  const regionKey = hmac(dateKey, REGION);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, "aws4_request");
}

function xmlValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([^<]+)</${tag}>`));
  return match?.[1] ?? null;
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    fail(`missing required environment variable ${name}`);
  }
  return value;
}

function contentTypeFor(filePath, explicitContentType) {
  if (explicitContentType) return explicitContentType;
  if (filePath.endsWith(".yml")) return "text/yaml";
  if (filePath.endsWith(".txt")) return "text/plain";
  if (filePath.endsWith(".blockmap")) return "application/json";
  return "application/octet-stream";
}

function buildRequest({
  accountId,
  accessKeyId,
  secretAccessKey,
  bucket,
  key,
  method,
  query = new URLSearchParams(),
  bodyHash,
  contentType,
  contentLength,
}) {
  const host = `${accountId}.r2.cloudflarestorage.com`;
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, "");
  const shortDate = amzDate.slice(0, 8);
  const headers = new Map([
    ["content-length", String(contentLength)],
    ["host", host],
    ["x-amz-content-sha256", bodyHash],
    ["x-amz-date", amzDate],
  ]);
  if (contentType) headers.set("content-type", contentType);

  const sortedHeaders = [...headers.entries()].sort(([left], [right]) =>
    left.localeCompare(right),
  );
  const canonicalHeaders = sortedHeaders
    .map(([name, value]) => `${name}:${String(value).trim()}\n`)
    .join("");
  const signedHeaders = sortedHeaders.map(([name]) => name).join(";");
  const canonicalRequest = [
    method,
    canonicalUri(`${bucket}/${key}`),
    canonicalQuery(query),
    canonicalHeaders,
    signedHeaders,
    bodyHash,
  ].join("\n");
  const credentialScope = `${shortDate}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = [
    "AWS4-HMAC-SHA256",
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const signature = createHmac("sha256", signingKey(secretAccessKey, shortDate))
    .update(stringToSign)
    .digest("hex");

  return {
    url: `https://${host}${canonicalUri(`${bucket}/${key}`)}${
      query.size > 0 ? `?${canonicalQuery(query)}` : ""
    }`,
    headers: {
      ...Object.fromEntries(headers),
      authorization: [
        `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${credentialScope}`,
        `SignedHeaders=${signedHeaders}`,
        `Signature=${signature}`,
      ].join(", "),
    },
  };
}

async function request(options) {
  const requestOptions = buildRequest(options);
  const response = await fetch(requestOptions.url, {
    method: options.method,
    headers: requestOptions.headers,
    body: options.body,
  });
  if (response.ok) return response;
  const body = await response.text();
  throw new Error(
    `[r2] ${options.method} ${options.key} failed: ${response.status} ${response.statusText}${body ? ` - ${body.slice(0, 500)}` : ""}`,
  );
}

async function putObject({ credentials, bucket, key, filePath, contentType }) {
  const file = await stat(filePath);
  const body = await readFile(filePath);
  await request({
    ...credentials,
    bucket,
    key,
    method: "PUT",
    body,
    bodyHash: sha256(body),
    contentType,
    contentLength: file.size,
  });
}

async function uploadMultipart({
  credentials,
  bucket,
  key,
  filePath,
  contentType,
  fileSize,
}) {
  const initiateResponse = await request({
    ...credentials,
    bucket,
    key,
    method: "POST",
    query: new URLSearchParams([["uploads", ""]]),
    body: "",
    bodyHash: sha256(""),
    contentType,
    contentLength: 0,
  });
  const uploadId = xmlValue(await initiateResponse.text(), "UploadId");
  if (!uploadId) fail(`multipart initiation returned no UploadId for ${key}`);

  const handle = await open(filePath, "r");
  const parts = [];
  try {
    let offset = 0;
    let partNumber = 1;
    while (offset < fileSize) {
      const length = Math.min(PART_SIZE, fileSize - offset);
      const buffer = Buffer.allocUnsafe(length);
      let bytesRead = 0;
      while (bytesRead < length) {
        const result = await handle.read(
          buffer,
          bytesRead,
          length - bytesRead,
          offset + bytesRead,
        );
        if (result.bytesRead === 0) fail(`unexpected end of file: ${filePath}`);
        bytesRead += result.bytesRead;
      }

      const response = await request({
        ...credentials,
        bucket,
        key,
        method: "PUT",
        query: new URLSearchParams([
          ["partNumber", String(partNumber)],
          ["uploadId", uploadId],
        ]),
        body: buffer,
        bodyHash: sha256(buffer),
        contentType,
        contentLength: buffer.length,
      });
      const etag = response.headers.get("etag")?.replaceAll('"', "");
      if (!etag) fail(`multipart part ${partNumber} returned no ETag for ${key}`);
      parts.push({ etag, partNumber });
      offset += length;
      console.log(
        `[r2] uploaded ${key}: ${offset}/${fileSize} bytes (${Math.round((offset / fileSize) * 100)}%)`,
      );
      partNumber += 1;
    }
  } catch (error) {
    console.error(`[r2] aborting multipart upload for ${key}`);
    await request({
      ...credentials,
      bucket,
      key,
      method: "DELETE",
      query: new URLSearchParams([["uploadId", uploadId]]),
      body: "",
      bodyHash: sha256(""),
      contentLength: 0,
    }).catch(() => {});
    throw error;
  } finally {
    await handle.close();
  }

  const completeXml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    "<CompleteMultipartUpload>",
    ...parts.map(
      ({ etag, partNumber }) =>
        `<Part><PartNumber>${partNumber}</PartNumber><ETag>"${etag}"</ETag></Part>`,
    ),
    "</CompleteMultipartUpload>",
  ].join("");
  await request({
    ...credentials,
    bucket,
    key,
    method: "POST",
    query: new URLSearchParams([["uploadId", uploadId]]),
    body: completeXml,
    bodyHash: sha256(completeXml),
    contentType: "application/xml",
    contentLength: Buffer.byteLength(completeXml),
  });
}

const args = parseArgs(process.argv.slice(2));
if (!args.key || !args.file) {
  fail(
    "usage: node scripts/upload-r2-object.mjs --key <object-key> --file <path> [--bucket <bucket>] [--content-type <mime>]",
  );
}

const credentials = {
  accountId: requireEnv("CLOUDFLARE_ACCOUNT_ID"),
  accessKeyId: requireEnv("CLOUDFLARE_R2_ACCESS_KEY_ID"),
  secretAccessKey: requireEnv("CLOUDFLARE_R2_SECRET_ACCESS_KEY"),
};
const bucket = args.bucket ?? DEFAULT_BUCKET;
const filePath = resolve(args.file);
const contentType = contentTypeFor(filePath, args["content-type"]);
const file = await stat(filePath);

console.log(
  `[r2] uploading ${basename(filePath)} (${file.size} bytes) to ${bucket}/${args.key}`,
);

if (file.size >= MULTIPART_THRESHOLD) {
  await uploadMultipart({
    credentials,
    bucket,
    key: args.key,
    filePath,
    contentType,
    fileSize: file.size,
  });
} else {
  await putObject({
    credentials,
    bucket,
    key: args.key,
    filePath,
    contentType,
  });
}

console.log(`[r2] upload complete: ${bucket}/${args.key}`);
