# Next-cloud-flare セッション引き継ぎ資料

最終更新: 2026-09-21（commit `4750995` 時点）

## 1. プロジェクト概要

Cloudflare のサービス（Workers / R2 / D1 / Durable Objects / Queues / Cron / KV / Images / Access / Static Assets）だけで完結する、Google Drive / Nextcloud 相当のセルフホスト型ストレージ。

要求機能: Web UI、WebDAV、期限付き・リンク共有（パスワード可）、回収箱、検索、分割アップロード、プレビュー・サムネイル、大量画像 Gallery、EPUB / CBZ(ZIP) 本棚リーダー、ASMR 向けオーディオ（タグ表示・連続再生・再生位置保存）、Cloudflare Access + 既設 Google IdP でのゼロトラスト認証。

**前提**: Google IdP は Cloudflare Access 側にすでに設定済み。アプリは IdP を作り直さない。

## 2. リポジトリ / ブランチ / PR

| 項目 | 値 |
|---|---|
| GitHub | `daraskme/Nextcloud-flare` |
| 実装ブランチ | `devin/1789973800-implementation` |
| PR | https://github.com/daraskme/Nextcloud-flare/pull/1 （Draft、未マージ。マージは明示指示があるまでしない） |
| `main` | 設計ドキュメントのみ |
| ローカル checkout（Devin VM） | `C:\Users\Administrator\repos\Next-cloud-flare` |
| E2E 用 worktree | `C:\Users\Administrator\repos\ncf-test` |

参照リポジトリ（変更しない）: `fanchenggang/Davflare`, `G4brym/R2-Explorer`。

## 3. ドキュメントの読み順

1. `docs/DESIGN.md` — 設計契約（v0.6、日本語）。データモデル、permit/epoch/fence、共有、GC、Gallery/本棚/オーディオ。
2. `docs/IMPLEMENTATION_BRIEF.md` — Phase 順序と R6 条件付き Go の解消条件（§8）。
3. `docs/STATUS.md` — **実装の現状の正**。設計との差分、E2E 修正履歴、既知の欠陥・制約、次の着手点。
4. `docs/REVIEW_LOG.md` — Astra レビュー R1〜R6 の要約。`docs/reviews/roundN-*.md` に生ログ。
5. `docs/reviews/e2e-findings-1.md`, `docs/reviews/sol-impl-prompt-*.md` — E2E 指摘と Sol への実装指示。
6. `README.md` — アーキテクチャ図と運用概要。

## 4. アーキテクチャ要点

- Worker: Hono + TypeScript。`packages/worker/src` に REST (`/api/v1`)、public share (`/s/*`, `/api/v1/public/*`)、content (`/c/*`)、WebDAV (`/dav/*`)、reader (`/reader/*`)。route manifest で全 route を宣言し、contract test で「handler 無し route が literal route を遮蔽しない」ことを固定。
- Web: React + Vite（`packages/web`）。private SPA (`index.html` → `/assets`)、public share shell (`public-share.html` → `/public-assets`)、reader (`reader.html` → `/reader-assets`) を **別 build** で自己完結 bundle 化（`/assets` は Access 保護のため共有 chunk 禁止）。
- D1: nodes / blobs / operations / permits / shares / trash / jobs / sessions 等。`_assert` テーブルへの INSERT を batch に混ぜ、条件不成立で rollback する barrier パターンを全 mutation で使用。
- R2: blob generation は immutable（`u/<owner>/b/<blobId>`）。派生物・サムネイル・backup も R2。
- DO: ControlDO（epoch 唯一発行者、R2 に履歴 mirror）、UploadDO（resumable upload）、LockDO（permit/fence）、BudgetDO（quota）。
- Queues: media-extract / library-index / audio-extract。file create/overwrite 後に `jobs/dispatch.ts` が pending job を送る（development では media-extract を送らない、test では送らない）。
- Cron: purge / multipart cleanup / GC / backup / repair / job dispatch。
- 認証: production は Access JWT のみ。`ENVIRONMENT=development` かつ loopback のみ dev principal（`dev_user`）。CSRF は session-bound HMAC（1h TTL）。
- Cookie: share session `__Host-ncf_share_<id>`、content session `__Host-ncf_cs`。**development かつ `APP_ORIGIN` が http:// のときだけ `__Host-` を外す**（Chrome が plain http で `InvalidPrefix` 拒否するため。`auth/cookies.ts`）。
- MIME: blob commit 時に先頭 64B を sniff（`services/mimeSniff.ts`）。宣言 MIME は passive 型のみ fallback。
- Content: `GET .../content?download=1` で `Content-Disposition: attachment`、無指定は `inline`。

## 5. ローカル環境と検証コマンド

環境: Windows / PowerShell、Node 20.19、pnpm 9.15.9（blueprint で `npm i -g pnpm@9` と `pnpm install` 済み）。

```powershell
pnpm install --frozen-lockfile
pnpm lint          # eslint + prettier --check
pnpm typecheck
pnpm test          # test:unit（vitest.unit.config.ts）→ test:integration（vitest.integration.config.ts, workers pool）
pnpm build         # shared → web（app / public-share / reader の 3 build）→ worker
pnpm verify:config # wrangler deploy --dry-run
pnpm dev           # Worker 8787（D1 local migration 適用込み）+ Vite 5173
```

- 単体ファイルの実行は config 指定が必須: `pnpm --filter ./packages/worker exec vitest run --config vitest.integration.config.ts test/integration/xxx.test.ts`（unit は `vitest.unit.config.ts`）。
- Vite dev proxy は `^/api|/dav|/s|/c|/public-assets|/reader|/reader-assets(?:/|$)` を 8787 へ（アンカー必須、`/s` が `/src` を吸う事故があった）。
- E2E worktree では HTTPS WebDAV 用 Worker を 8791 で別起動している（Basic auth を http で送らないため）。手順は `C:\Users\Administrator\ncf-e2e\SKILL.md`（未コミット、テストエージェントのメモ）。
- 直近の全体検証: lint / typecheck / build 緑。unit 26 files / 76 tests、integration 38 files / 82 tests 緑（`4750995`）。

## 6. E2E（ローカル、テストエージェント）の合否サマリ

合格: Unicode/emoji 名、traversal 名 `400 invalid_name`、同名衝突（上書き/両方保持/スキップ/版復元）、回収箱（復元/再削除/完全削除）、ライト/ダーク theme、容量表示、テキスト/PNG/PDF プレビュー、モバイル top bar/drawer、WebDAV 18 assertion（XML 宣言 LOCK、DTD/ENTITY 拒否含む）、Gallery（フォルダ scope 15 / 再帰 30、lightbox）、CBZ/EPUB 読書位置保存、RAR/deflate64/zip-bomb のクリーンな unsupported、オーディオタグ・Range 206・再生位置保存、MIME sniff、**公開共有**（別 shell、誤パスワード 401、正パスワード解錠、ファイル DL SHA 一致、フォルダ ZIP 30 件一致、subtree 分離 404、無効化 410、期限切れ 410）。

未修正 / 制約（詳細は STATUS.md「既知の欠陥・制約」）:
- Audio: 前トラック終了後の queue 遷移で Pause 表示のまま停止することがある。ネストしたフォルダの album が picker に出ない。MP3 duration は bounded 推定（30s が 0:34 等）。
- Starred / Tags の UI 操作なし。
- DAV: 削除直後の同名 collection 再作成は trash 中 node と衝突し 409。
- local dev では `/s/*` から `/api/v1/me` を叩くと dev principal で 200（loopback bypass の副作用、production は Access が gate）。
- `/c/*` content-session cookie 経路は public UI が直接 `/api/v1/public/.../content` を使うためブラウザ未検証（integration test のみ）。
- Gallery のサムネイルは local では placeholder（Images binding 無し）。
- `4750995`（`?download=1` / ZIP ボタン復帰）はブラウザ未再検証。

## 7. 未実施（Phase 9 / release gate）

- 実 Cloudflare 環境（staging）での疎通: Access + Google IdP、D1/R2/Queues/Cron/DO placement、Images、R2 multipart lifecycle、Time Travel restore、Range/Cookie/CORS。
- 実 WebDAV client（rclone / Finder / Explorer / litmus）互換。
- README support matrix、監視、resource inventory、a11y/touch/低性能端末、運用演習。
- production secrets: `APP_PASSWORD_PEPPER`（32 文字以上）、`CSRF_KEY`、`CONTENT_SESSION_KEY`（32 文字以上）等。`wrangler.jsonc` の binding と `docs/STATUS.md` を参照。
- 未実装機能一覧は STATUS.md「未実装」節。

## 8. 作業ルール（このプロジェクトで守ってきたこと）

- キリのいいところで commit / push（ユーザー指示）。`git add` は明示ファイル指定、`git add .` 禁止。`docs/reviews/*.err|*.out` は意図的に未追跡。
- `main` へ直接 push しない。PR #1 は指示なしにマージしない。
- コード変更後は `pnpm lint` / `pnpm typecheck` / 影響テスト / `pnpm build`。
- ブラウザ E2E はテストエージェントに委譲（承認文言: `User clicked "Web UI をローカルで E2E テスト"`）。報告の成果物パスはそのまま添付。
- Astra / Sol の呼び出しは Devin CLI（VM にインストール・ログイン済み）: `devin -p --model gpt-6-astra`（レビュー）、`devin -p --model gpt-5-6-sol-high`（実装）。stdin ではなくプロンプトファイル + 出力ファイル経由で実行し、`docs/reviews/` にプロンプトと出力を残す。
- 設計と実装がずれた場合は STATUS.md に記録してから進める。

## 9. 直近の commit（新しい順）

| commit | 内容 |
|---|---|
| `4750995` | `?download=1` で attachment 配信、公開 ZIP ボタンの Preparing 固着修正 |
| `ee2202f` | plain-http development で cookie の `__Host-` prefix を外す（公開共有 unlock→401 の原因） |
| `0abec6c` | public-share / reader を自己完結 bundle として別 build |
| `cc27aea` | Vite proxy に reader/public/content route 追加、Gallery を現在フォルダに scope |
| `2d4de3f` | PreviewDialog、モバイル drawer/top bar、`duplicate_request` map と未開始 claim 破棄 |
| `ddead8f` | MIME sniff、job dispatch、DAV XML 宣言受理、明示 app shell/assets handler |
| `cf3cd88` | handler 無し `library/:nodeId` route の遮蔽除去 |
| `1c5afa8` | Vite proxy アンカー修正 |
| `86bf24e` 以前 | Phase 0〜8C 実装（Sol）と第1回 E2E 修正 |
