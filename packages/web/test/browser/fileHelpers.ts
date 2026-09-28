import type { Page } from "@playwright/test";

/** Virtualized lists may not mount a named row until the user searches for it. */
export async function searchFiles(page: Page, name: string) {
  await page.getByRole("searchbox", { name: "このフォルダー内を検索" }).fill(name);
  await page.getByRole("button", { name: "検索", exact: true }).click();
}
