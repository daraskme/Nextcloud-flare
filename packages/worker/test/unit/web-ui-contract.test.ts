import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function web(path: string): string {
  return readFileSync(fileURLToPath(new URL(`../../../web/${path}`, import.meta.url)), "utf8");
}

describe("web UI regression contract", () => {
  it("defines semantic light and dark colors without hard-coded white text utilities", () => {
    const styles = web("src/styles.css");
    for (const variable of ["--fg", "--fg-muted", "--bg", "--surface", "--border", "--accent"]) {
      expect(styles).toContain(variable);
    }
    expect(styles).toContain(':root[data-theme="dark"]');
    const components = [
      "src/App.tsx",
      "src/features/files/FileBrowser.tsx",
      "src/features/files/FileDetails.tsx",
      "src/features/files/ShareDialog.tsx",
      "src/features/gallery/GalleryView.tsx",
      "src/features/search/SearchPalette.tsx",
      "src/features/settings/AppPasswords.tsx",
      "src/features/shares/SharesView.tsx",
      "src/features/trash/TrashView.tsx",
      "src/features/uploads/UploadManager.tsx",
    ].map(web);
    expect(components.join("\n")).not.toContain("text-white");
  });

  it("keeps Japanese default copy, the disabled badge, adaptive storage, and public dev proxies", () => {
    const messages = web("src/i18n.ts");
    expect(messages).toContain('"shares.disabled": "無効化済み"');
    expect(messages).toContain('?? "ja"');
    expect(web("src/features/shares/SharesView.tsx")).toContain('t("shares.disabled")');
    expect(web("src/App.tsx")).toContain("formatBytes(storageUsed)");
    const vite = web("vite.config.ts");
    expect(vite).toContain('"/api"');
    expect(vite).toContain('"/dav"');
    expect(vite).toContain('"/s"');
  });
});
