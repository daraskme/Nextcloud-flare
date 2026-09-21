あなたは Next-cloud-flare の実装担当（Sol）の続きです。前回の run で Phase 0〜1 が完了し、`docs/STATUS.md` に到達状況が記録されています。

## まず読む
- `docs/STATUS.md`（前回の到達点・未実装・設計へのフィードバック）
- `docs/IMPLEMENTATION_BRIEF.md`（特に §2 の Phase 表と §8）
- `docs/DESIGN.md` の該当 Phase 節
- 既存コード: `packages/worker/src`, `packages/shared/src`, `packages/web/src`

## 今回の目標
`docs/reviews/sol-impl-prompt.md` と同じ規約・禁止事項のもとで、**Phase 2（Files core）→ Phase 3（Upload/copy job）→ Phase 4（trash/GC/recovery）→ Phase 5（list/search/stats）** を順に実装する。各 Phase 完了ごとに lint/typecheck/test/build を通して、明示ファイル指定でコミットする（`git add .`/`-A`/amend 禁止）。

- Web UI（`packages/web`）も各 Phase に対応する画面を実装する: ファイルブラウザ（グリッド/リスト切替、パンくず、右クリック/コンテキストメニュー、複数選択、ドラッグ&ドロップ移動）、アップロード（D&D、分塊、進捗、再開）、回収箱（復元/完全削除）、検索（コマンドパレット風）、容量表示。デザインはモダン（ダーク既定 + ライト、Tailwind、`lucide-react`、滑らかなトランジション）。ローカル開発では Access JWT を必要としない dev-only の principal 注入（`.dev.vars` の `DEV_PRINCIPAL_EMAIL` 等、production では無効化されコンパイル時/起動時に fail-closed）を用意し、`pnpm dev` で UI が実際に動くようにする。
- Cloudflare Access JWT/JWKS verifier（RS256、issuer/audience/exp/nbf/iat、kid 再取得 rate limit、fail-closed）を Phase 2 の最初に実装する（DESIGN §認証 に従う）。
- 到達できなかった Phase は着手しない。到達分を `docs/STATUS.md` に更新してコミット。
- 設計との矛盾は `docs/DESIGN.md` を編集せず `docs/STATUS.md` の「設計へのフィードバック」に追記。

## 出力
最後に標準出力へ: 到達 Phase、コミット一覧、lint/typecheck/test/build の結果、未実装項目、設計へのフィードバックを日本語で要約する。
