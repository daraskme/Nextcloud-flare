あなたは Next-cloud-flare の実装担当（Sol）です。作業ディレクトリはこのリポジトリのルートです。

## 正本
- `docs/DESIGN.md` (v0.6) — 設計契約
- `docs/IMPLEMENTATION_BRIEF.md` — 実装順序・不変条件・禁止事項。**§8「R6 条件付き Go の確定事項」は v0.6 本文より優先**
- `docs/reviews/round5-resolution.md`, `docs/reviews/round6-astra.md` — 経緯
- 参考実装（読取専用、コピー禁止）: `../Davflare`, `../R2-Explorer`

## 目標
Brief の Phase 0 → 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8A → 8B → 8C の順に、**動くコードとテスト**を実装する。各 Phase 完了ごとに `git add <明示ファイル>` + `git commit`（`git add .`/`-A` は禁止、amend 禁止）。時間・コンテキストの都合で全 Phase に到達できない場合は、**到達した Phase までを lint/typecheck/test 通過状態で残し、`docs/STATUS.md` に到達 Phase・未実装・既知の欠陥・次に着手すべき点を書いてコミット**する。半端な Phase をコミットするより、直前 Phase で綺麗に止めることを優先する。

## 技術スタック（固定）
- pnpm workspace (`pnpm@9`), Node 20, TypeScript strict, ESM
- `packages/worker`: Cloudflare Workers + Hono、`wrangler.jsonc`、D1 migrations (`migrations/*.sql`)、Durable Objects (ControlDO / LockDO / UploadDO / BudgetDO)、Queues consumer、Cron
- `packages/web`: Vite + React 18 + TypeScript + Tailwind CSS、Workers Static Assets で配信（`run_worker_first`）。UI は**モダンでかっこよく**（ダーク既定 + ライト、洗練されたタイポグラフィ、グリッド/リスト切替、滑らかなトランジション、ギャラリーの masonry/justified layout、Lightbox、本棚（表紙グリッド）、EPUB/CBZ リーダー、ミニプレイヤー付きオーディオ再生、キーボードショートカット、ドラッグ&ドロップアップロード、コマンドパレット風検索）。コンポーネントは自作 + `lucide-react` アイコン。過剰な UI ライブラリ依存は避ける
- `packages/shared`: zod contracts、error codes、limits
- テスト: `vitest` + `@cloudflare/vitest-pool-workers`（実 D1/R2/DO を Miniflare で）。lint: `eslint` (typescript-eslint flat config) + `prettier`。root scripts: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`
- 依存は公開 7 日以上経過した exact version に固定。`fflate` は同期 API のみ。hash は `crypto.subtle` / `DigestStream`
- 秘密情報をコード・テスト・ログに書かない。`wrangler.jsonc` の ID は placeholder（`<D1_ID>` 等）にし、`.dev.vars.example` を用意

## 必須の作法
- Brief §1 不変条件10か条と §7 禁止事項を破らない。安全性契約が不明な箇所は推測せず、その機能を閉じて `docs/STATUS.md` に記録する
- Phase 0 の D1 `_assert`/`changes()` 実証テストを最初に書き、結果に応じて §8 #1 の fallback を選ぶ。選択結果を `docs/STATUS.md` に記載
- Brief §8 の fixture 名でテストを作る（少なくとも #1, #2, #5, #6, #9 は Phase 到達時に必須）
- route は `packages/worker/src/routes/manifest.ts` に集約し、manifest に無い route が Hono に登録されていないことを CI テストで検証
- `README.md` を書く: 概要、アーキテクチャ図（mermaid）、セットアップ（Cloudflare Access アプリ・Bypass policy・D1/R2/KV/Queues 作成・`wrangler secret`）、開発コマンド、テスト、デプロイ手順、v1 サポートマトリクス
- 実装中は `pnpm lint && pnpm typecheck && pnpm test` を Phase 毎に通す。`pnpm build` も通す
- 途中で設計と実装の矛盾を見つけたら、`docs/DESIGN.md` は編集せず `docs/STATUS.md` の「設計へのフィードバック」に列挙する

## 出力
最後に標準出力へ: 到達 Phase、コミット一覧、lint/typecheck/test/build の結果、未実装項目、設計へのフィードバックを日本語で要約する。
