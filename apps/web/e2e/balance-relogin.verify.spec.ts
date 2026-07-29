/** Verifies that an upstream balance failure offers an in-place retry. */
import { expect, test } from "@playwright/test";

const BASE_URL = "http://localhost:5173";
// Electron UA makes AuthLayout skip the better-auth session gate.
const ELECTRON_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Claw-Pi/0.3.15 Chrome/120 Electron/28 Safari/537.36";

test.use({ userAgent: ELECTRON_UA });

test("successful balance response renders the account balance", async ({
  page,
}) => {
  await page.route("**/api/internal/activation/balance", (route) =>
    route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        ok: true,
        balance_cents: 5000,
        total_recharged: 10000,
      }),
    }),
  );
  await page.route("**/api/internal/activation/transactions**", (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({
        success: true,
        transactions: [],
        total: 0,
        page: 1,
        page_size: 10,
      }),
    }),
  );
  await page.route("**/api/internal/activation/usage-logs**", (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({
        success: true,
        logs: [],
        total: 0,
        page: 1,
        page_size: 10,
      }),
    }),
  );
  await page.route(
    "**/api/internal/payment/alipay/pending-orders**",
    (route) =>
      route.fulfill({
        status: 200,
        body: JSON.stringify({ ok: true, orders: [] }),
      }),
  );
  await page.route("**/api/v1/models**", (route) =>
    route.fulfill({
      status: 200,
      body: JSON.stringify({ data: [] }),
    }),
  );

  await page.goto(`${BASE_URL}/workspace/recharge`);

  await expect(page.getByText("¥50.00", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
});

test("upstream balance failure stays on the page and retries", async ({
  page,
}) => {
  const cloudCalls: string[] = [];
  let balanceCalls = 0;

  // Spy: fail loudly if the old reconnect path is hit.
  await page.route("**/api/internal/desktop/cloud-connect", async (route) => {
    cloudCalls.push("cloud-connect");
    await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
  });
  await page.route("**/api/internal/desktop/cloud-disconnect", async (route) => {
    cloudCalls.push("cloud-disconnect");
    await route.fulfill({ status: 200, body: JSON.stringify({ ok: true }) });
  });

  await page.route(
    "**/api/internal/activation/balance",
    async (route) => {
      balanceCalls += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ ok: false, error: "invalid tokens, please wait" }),
      });
    },
  );

  // Silence other data calls the page may make.
  await page.route("**/api/internal/activation/transactions**", (r) =>
    r.fulfill({ status: 200, body: JSON.stringify({ success: true, transactions: [], total: 0, page: 1, page_size: 10 }) }),
  );
  await page.route("**/api/internal/activation/usage-logs**", (r) =>
    r.fulfill({ status: 200, body: JSON.stringify({ success: true, logs: [], total: 0, page: 1, page_size: 10 }) }),
  );
  await page.route("**/api/internal/payment/alipay/pending-orders**", (r) =>
    r.fulfill({ status: 200, body: JSON.stringify({ ok: true, orders: [] }) }),
  );
  await page.route("**/api/v1/models**", (r) =>
    r.fulfill({ status: 200, body: JSON.stringify({ data: [] }) }),
  );

  await page.goto(`${BASE_URL}/workspace/recharge`);

  const btn = page.getByRole("button", { name: /重新加载|Reload/u });
  await expect(btn).toBeVisible({ timeout: 15_000 });

  await btn.click();
  await expect.poll(() => balanceCalls).toBeGreaterThan(1);
  await expect(page).toHaveURL(`${BASE_URL}/workspace/recharge`);
  expect(cloudCalls).toEqual([]);

  await page.screenshot({ path: "e2e-verify-after-click.png", fullPage: false });
});
