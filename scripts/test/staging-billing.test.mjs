import assert from "node:assert/strict";
import { test } from "vitest";
import { fetchBillableUsage, summarizeBillableUsage } from "../../ops/staging/billing-snapshot.mjs";

const accountId = "a".repeat(32);
const row = (overrides = {}) => ({
  BillingAccountId: accountId,
  BillingPeriodStart: "2026-09-19T00:00:00Z",
  BillingCurrency: "USD",
  ChargeCategory: "Usage",
  ChargePeriodStart: "2026-10-01T00:00:00Z",
  ChargePeriodEnd: "2026-10-02T00:00:00Z",
  BilledCost: 0.15,
  ...overrides,
});

test("summarizes only reported account-wide usage in the latest billing period", () => {
  const result = summarizeBillableUsage(
    [
      row(),
      row({ BilledCost: 0.05 }),
      row({
        ChargePeriodStart: "2026-10-02T00:00:00Z",
        ChargePeriodEnd: "2026-10-03T00:00:00Z",
        BilledCost: 9,
      }),
      row({ BillingPeriodStart: "2026-08-19T00:00:00Z", BilledCost: 7 }),
    ],
    accountId,
    new Date("2026-10-02T20:00:00Z"),
  );
  assert.equal(result.scope, "account-wide-metered-usage");
  assert.equal(result.billingPeriodStart, "2026-09-19T00:00:00Z");
  assert.equal(result.reportedPeriodEnd, "2026-10-02T00:00:00Z");
  assert.equal(result.billed, 0.2);
  assert.deepEqual(result.days, [{ date: "2026-10-01", billed: 0.2, records: 2 }]);
  assert.equal(result.stagingAttribution, "unavailable");
});

test("rejects mixed accounts, currencies, and invalid charges", () => {
  assert.throws(
    () => summarizeBillableUsage([row({ BillingAccountId: "b".repeat(32) })], accountId),
    /billing_account_mismatch/,
  );
  assert.throws(
    () => summarizeBillableUsage([row(), row({ BillingCurrency: "JPY" })], accountId),
    /billing_currencies_mixed/,
  );
  assert.throws(
    () => summarizeBillableUsage([row({ BilledCost: Number.NaN })], accountId),
    /billing_cost_invalid/,
  );
});

test("fetches only the account billable usage endpoint and hides API errors", async () => {
  const calls = [];
  const result = await fetchBillableUsage(accountId, "private-token", async (url, options) => {
    calls.push({ url, options });
    return Response.json({ success: true, result: [row()] });
  });
  assert.equal(result.length, 1);
  assert.equal(
    calls[0].url,
    `https://api.cloudflare.com/client/v4/accounts/${accountId}/billable-usage`,
  );
  assert.equal(calls[0].options.headers.Authorization, "Bearer private-token");
  await assert.rejects(
    fetchBillableUsage(
      accountId,
      "private-token",
      async () => new Response("sensitive", { status: 403 }),
    ),
    (error) => error.message === "billing_http_403",
  );
});
