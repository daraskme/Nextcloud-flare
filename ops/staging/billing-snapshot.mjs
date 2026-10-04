#!/usr/bin/env node
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const API_ORIGIN = "https://api.cloudflare.com";

function assert(condition, code) {
  if (!condition) throw new Error(code);
}

function money(value) {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}

export function summarizeBillableUsage(records, accountId, now = new Date()) {
  assert(Array.isArray(records), "billing_records_invalid");
  assert(/^[a-f0-9]{32}$/.test(accountId), "billing_account_id_invalid");
  assert(Number.isFinite(now.getTime()), "billing_time_invalid");
  assert(records.length > 0, "billing_records_empty");

  const periods = new Set();
  const currencies = new Set();
  for (const row of records) {
    assert(row?.BillingAccountId === accountId, "billing_account_mismatch");
    assert(typeof row.BillingPeriodStart === "string", "billing_period_invalid");
    assert(typeof row.BillingCurrency === "string", "billing_currency_invalid");
    periods.add(row.BillingPeriodStart);
    currencies.add(row.BillingCurrency);
  }
  assert(currencies.size === 1, "billing_currencies_mixed");
  const billingPeriodStart = [...periods].sort().at(-1);
  assert(Number.isFinite(Date.parse(billingPeriodStart)), "billing_period_invalid");

  const daily = new Map();
  let reportedPeriodEnd = null;
  for (const row of records) {
    if (row.BillingPeriodStart !== billingPeriodStart) continue;
    assert(row.ChargeCategory === "Usage", "billing_charge_category_invalid");
    const start = Date.parse(row.ChargePeriodStart);
    const end = Date.parse(row.ChargePeriodEnd);
    assert(
      Number.isFinite(start) && Number.isFinite(end) && start < end,
      "billing_charge_period_invalid",
    );
    assert(
      typeof row.BilledCost === "number" && Number.isFinite(row.BilledCost),
      "billing_cost_invalid",
    );
    if (end > now.getTime()) continue;
    const date = row.ChargePeriodStart.slice(0, 10);
    const entry = daily.get(date) ?? { billed: 0, records: 0 };
    entry.billed += row.BilledCost;
    entry.records += 1;
    daily.set(date, entry);
    if (reportedPeriodEnd === null || row.ChargePeriodEnd > reportedPeriodEnd)
      reportedPeriodEnd = row.ChargePeriodEnd;
  }

  const days = [...daily]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, entry]) => ({ date, billed: money(entry.billed), records: entry.records }));
  const billed = money([...daily.values()].reduce((sum, entry) => sum + entry.billed, 0));
  return {
    scope: "account-wide-metered-usage",
    billingCurrency: [...currencies][0],
    billingPeriodStart,
    reportedPeriodEnd,
    billed,
    days,
    stagingAttribution: "unavailable",
    note: "Account-wide metered charges only. Rows may arrive late; the latest date can be partial. This is neither staging-only spend nor a final invoice.",
  };
}

export async function fetchBillableUsage(accountId, token, fetchImpl = fetch) {
  assert(/^[a-f0-9]{32}$/.test(accountId), "billing_account_id_invalid");
  assert(typeof token === "string" && token.length > 0, "billing_token_missing");
  const response = await fetchImpl(`${API_ORIGIN}/client/v4/accounts/${accountId}/billable-usage`, {
    headers: { Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`billing_http_${response.status}`);
  const body = await response.json();
  assert(body?.success === true, "billing_api_failed");
  return body.result;
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "--execute") {
    console.log("Usage: node ops/staging/billing-snapshot.mjs --execute");
    return;
  }
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const token = process.env.CLOUDFLARE_API_TOKEN;
  const rows = await fetchBillableUsage(accountId, token);
  console.log(JSON.stringify(summarizeBillableUsage(rows, accountId), null, 2));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : "billing_unavailable");
    process.exitCode = 1;
  });
}
