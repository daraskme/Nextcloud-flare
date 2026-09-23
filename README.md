# Next-cloud-flare

Cloudflare 上で動かすセルフホスト型ファイル管理アプリ。仕様は
[設計書](docs/DESIGN.md)、実装順序は [実装ブリーフ](docs/IMPLEMENTATION_BRIEF.md) を参照。

**別セッションでの再開は [引き継ぎ資料](docs/HANDOFF.md) から。** 実装済み・未実装・検証済み・未検証の一覧は [現在状態](docs/CURRENT_STATE.md) にまとめています。

現在は **Phase 0 のローカル検証基盤、Phase 1 の大半、Phase 2 / WebDAV / Phase 3 の一部**を実装済み。
61通常テーブル、migration `0001`〜`0023`、147経路の契約があり、主要なFiles REST/WebDAV mutation、trash/restore/purge、fenced R2 GC、content ticket/blob配信、private単一・分割アップロードまでローカル接続しています。
アップロードは予約・R2送信・原子的確定・中止・既知IDの期限切れ回収を実装し、[private HTTP](docs/UPLOAD_HTTP.md)から接続しています。未知の完成済みobjectは[隔離・35日後の回収](docs/ORPHAN_INVENTORY.md)まで接続しています。既存uploadの未知multipart IDは[永続走査・中止](docs/MULTIPART_INVENTORY.md)まで接続しました。完全な閉鎖証明と予約精算、Files UIは未実装です。ControlDO admissionも安全な再開処理が完成するまで閉じており、製品としてはまだ利用できません。
詳細は [Foundation 実装契約](docs/FOUNDATION.md) を参照してください。

| 資料 | 用途 |
|---|---|
| [HANDOFF](docs/HANDOFF.md) | セッション再開の入口・直近の作業順序 |
| [CURRENT_STATE](docs/CURRENT_STATE.md) | 実装/検証の4区分、未完了一覧、セッション間の固定事項 |
| [IMPLEMENTATION_STATUS](docs/IMPLEMENTATION_STATUS.md) | 実装状況・検証記録・未完了 gate |
| [FOUNDATION](docs/FOUNDATION.md) | 現在の内部サービスと DB の契約 |
| [UPLOAD_HTTP](docs/UPLOAD_HTTP.md) | private単一/分割アップロードのHTTPと再送契約 |
| [ORPHAN_INVENTORY](docs/ORPHAN_INVENTORY.md) | 未追跡の完成済みobjectの隔離・会計・35日回収 |
| [MULTIPART_INVENTORY](docs/MULTIPART_INVENTORY.md) | S3未完了multipart/part/lifecycleの診断と修復前提 |
| [IMPLEMENTATION_BRIEF](docs/IMPLEMENTATION_BRIEF.md) | 全体の実装順序・R6 確定条件 |
| [DESIGN](docs/DESIGN.md) | 製品全体の設計・受入条件 |
| [MEDIA_FORMATS](docs/MEDIA_FORMATS.md) | AVIF・AV1・Opus の追加要件 |
| [REVIEW_LOG](docs/REVIEW_LOG.md) | 過去レビューの経緯。関連箇所だけ参照 |

## 開発

Node **24.21.0** / pnpm **12.4.1** を使用します。

```sh
pnpm install --frozen-lockfile
pnpm check
pnpm dev
```

`pnpm dev` はローカル binding だけを使用します。`wrangler.jsonc` の resource ID はローカル専用です。
リモート DB、bucket、Access policy の作成・配備は行いません。

| コマンド | 内容 |
|---|---|
| `pnpm lint` / `pnpm typecheck` | 静的検査 |
| `pnpm test:unit` | Node / SQLite 単体テスト |
| `pnpm test:integration` | assets build 後、workerd の D1 / R2 / DO / Images を検証 |
| `pnpm verify:contracts` | バージョン固定・公開日・上限・禁止 API の検査 |
| `pnpm verify:config` | ローカル binding と外部公開設定の検査 |
| `pnpm build` | Web build と Worker の dry-run bundle |
| `pnpm check` | 上記の検査・テスト・build を一括実行 |

`.dev.vars*`、`.env*`、`.wrangler/` は Git 対象外です。
ブラウザ機能が未実装のため、E2E コマンドはまだ定義していません。

## 検証の範囲

D1 の全 rollback、G01 の3反例、commit 応答喪失、permit/session/epoch の commit 述語、
95MB ストリーム、SHA-256、Range、ZIP STORE、PBKDF2、binding のローカル検証を含みます。
JWT/JWKS の失敗境界、bootstrap の競合/応答喪失、4 principal の node 認可と失効対 commit も検証しています。

Cloudflare 上の実 D1、ネットワーク障害、Images の実サービス制限・codec・費用、
Access、環境分離、Queue retention は staging gate に残っています。
ローカルテスト合格を Phase 0 全体や製品機能のリリース判定には使いません。
詳細と次の作業は [進捗・復旧手順](docs/IMPLEMENTATION_STATUS.md) に記録しています。
