#!/usr/bin/env node
import { promisify } from "node:util";
import { randomBytes, scrypt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_EMAIL = "56935222@qq.com";
const scryptAsync = promisify(scrypt);

function parseArgs(argv) {
  const args = {
    confirm: false,
    dryRun: false,
    email: DEFAULT_EMAIL,
    password: null,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--confirm") {
      args.confirm = true;
    } else if (arg === "--dry-run") {
      args.dryRun = true;
    } else if (arg === "--email") {
      args.email = argv[++i];
    } else if (arg === "--password") {
      args.password = argv[++i];
    } else if (arg === "--help" || arg === "-h") {
      printHelp();
      process.exit(0);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  if (!args.email || !args.email.includes("@")) {
    throw new Error("A valid --email is required.");
  }

  return args;
}

function printHelp() {
  console.log(`Usage:
  DATABASE_URL="postgresql://..." node scripts/reset-cloud-user-password.mjs --confirm
  DATABASE_URL="postgresql://..." node scripts/reset-cloud-user-password.mjs --email user@example.com --password "NewPass123!" --confirm

Options:
  --email      Target user email. Defaults to ${DEFAULT_EMAIL}
  --password   Temporary password. If omitted, a random password is generated.
  --dry-run    Query the user/account only; do not update the database.
  --confirm    Required for a real reset.
`);
}

function loadDotenvIfPresent() {
  const scriptDir = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), ".env.local"),
    resolve(process.cwd(), ".env.production"),
    resolve(scriptDir, "..", ".env"),
    resolve(scriptDir, "..", ".env.local"),
    resolve(scriptDir, "..", ".env.production"),
  ];

  for (const file of candidates) {
    if (!existsSync(file)) continue;
    const content = readFileSync(file, "utf8");
    for (const rawLine of content.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const index = line.indexOf("=");
      if (index <= 0) continue;
      const key = line.slice(0, index).trim();
      if (process.env[key]) continue;
      const value = line
        .slice(index + 1)
        .trim()
        .replace(/^['"]|['"]$/g, "");
      process.env[key] = value;
    }
  }
}

function makeTemporaryPassword() {
  return `ClawPi-${randomBytes(6).toString("base64url")}-Tmp`;
}

async function hashBetterAuthPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const key = await scryptAsync(password.normalize("NFKC"), salt, 64, {
    N: 16384,
    r: 16,
    p: 1,
    maxmem: 128 * 16384 * 16 * 2,
  });
  return `${salt}:${Buffer.from(key).toString("hex")}`;
}

async function loadPgClient() {
  try {
    const pg = await import("pg");
    return pg.Client;
  } catch {
    throw new Error(
      "The pg package is not installed. Run `npm i pg` in this directory, then retry.",
    );
  }
}

async function main() {
  loadDotenvIfPresent();
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error(
      "DATABASE_URL is missing. Set it before running this script.",
    );
  }

  if (!args.confirm && !args.dryRun) {
    throw new Error("Refusing to update without --confirm. Use --dry-run to inspect only.");
  }

  const newPassword = args.password ?? makeTemporaryPassword();
  const Client = await loadPgClient();
  const client = new Client({
    connectionString: databaseUrl,
    ssl:
      process.env.PGSSLMODE === "require" ||
      process.env.DATABASE_SSL === "true"
        ? { rejectUnauthorized: false }
        : undefined,
  });

  await client.connect();
  try {
    await client.query("BEGIN");

    const userResult = await client.query(
      `SELECT id, email, name FROM "user" WHERE lower(email) = lower($1) LIMIT 2`,
      [args.email],
    );

    if (userResult.rowCount === 0) {
      throw new Error(`No user found for email: ${args.email}`);
    }
    if (userResult.rowCount > 1) {
      throw new Error(`Multiple users found for email: ${args.email}`);
    }

    const user = userResult.rows[0];
    const accountResult = await client.query(
      `SELECT id, "userId", "providerId", "accountId", password
       FROM "account"
       WHERE "userId" = $1 AND "providerId" = 'credential'
       LIMIT 2`,
      [user.id],
    );

    if (accountResult.rowCount === 0) {
      throw new Error(
        `User ${args.email} has no credential account. Do not reset manually until the account binding is confirmed.`,
      );
    }
    if (accountResult.rowCount > 1) {
      throw new Error(`Multiple credential accounts found for: ${args.email}`);
    }

    const account = accountResult.rows[0];
    console.log(`User found: ${user.email} (${user.id})`);
    console.log(`Credential account: ${account.id}`);

    if (args.dryRun) {
      await client.query("ROLLBACK");
      console.log("Dry run complete. No database changes were made.");
      return;
    }

    const passwordHash = await hashBetterAuthPassword(newPassword);

    const updateResult = await client.query(
      `UPDATE "account"
       SET password = $1, "updatedAt" = $2
       WHERE id = $3 AND "userId" = $4 AND "providerId" = 'credential'`,
      [passwordHash, new Date().toISOString(), account.id, user.id],
    );

    if (updateResult.rowCount !== 1) {
      throw new Error("Password update did not affect exactly one account row.");
    }

    const sessionResult = await client.query(
      `DELETE FROM "session" WHERE "userId" = $1`,
      [user.id],
    );

    await client.query("COMMIT");

    console.log("Password reset complete.");
    console.log(`Email: ${user.email}`);
    console.log(`Temporary password: ${newPassword}`);
    console.log(`Revoked sessions: ${sessionResult.rowCount}`);
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    await client.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
