# Next-cloud-flare 設計レビュー履歴

設計書 `docs/DESIGN.md` を GPT-6 Astra（レビュアー）と GPT-5.6 Sol（改訂・実装）で往復した記録。
各ラウンドの原文は `docs/reviews/roundN-astra.md`、反映表は `docs/reviews/roundN-resolution.md`。

| ラウンド | 観点 | レビュアー / モデル | 判定 | 設計版 | 主な変更 |
|---|---|---|---|---|---|
| 1 | 通常設計レビュー | Astra `gpt-6-astra-high` | 実装非推奨 (Blocker 15 / Major 17 / Minor 16) | v0.1 → v0.2 | 不変 blob + `nodes.current_blob_id/revision`、D1 を正本化・バックアップ/Time Travel 手順、root node と `name_ci` 一意制約、クォータ予約、`trash_ops` 削除操作単位の回収箱、LockDO(space) + `fsMutation` 共通境界、UploadDO 状態機械、principal/capability 権限表、公開パス `/api/v1/public/*` と Bypass 一致、プロトコル別 CSRF・用途別 CSP、サイズ上限再定義（95 MB / 64 MiB part / 10,000 parts）、Images 20 MB・WASM 別予算、ZIP v1 上限、Cron `SUN` + D1 lease、owner bootstrap `OWNER_EMAILS`、identity = iss+sub、outbox 付きサムネイル Queue、bigram 検索テーブル分離、機能マトリクス (v1/v1.1/非目標)、障害境界テスト |
| 2 | 敵対的レビュー (red team) | Astra `gpt-6-astra-high` | No (P0 9 件 / P1 4 件) | v0.2 → v0.3 | fsMutation 疑似コード・operation claim・影響行検証、`tree_generation` による構造変更直列化、trash_ops 排他状態機械と FK 削除順序、GC 不可逆点と猶予 35 日、ControlDO epoch による復旧時の旧 job/ticket 無効化、物理容量台帳 `physical_bytes`、UploadDO 失敗終端と barrier、operand 全域の認可と ticket の node 束縛、upload-only 自動リネーム、node_id 単位ロック + owner 限定 UNLOCK、collection ETag に node_id、ZIP entry 1,000 上限、D1 容量攻撃上限、費用冪等 |
| 3 | セキュリティ / 認証・認可 | Astra | (実施中) | v0.3 → v0.4 | |
| 4 | Cloudflare 制約・実装可能性 | Astra | (未実施) | v0.4 → v0.5 | |
| 5 | 最終判定・Sol 引き渡し | Astra | (未実施) | v0.5 → final | |

## 運用メモ

- レビューは Devin CLI `devin -p --model <model> --permission-mode dangerous --prompt-file docs/reviews/roundN-prompt.md` で実行。
- 改訂は Sol (`gpt-5-6-sol-xhigh`) に `docs/reviews/roundN-revise-prompt.md`（確定方針付き）で委譲。
