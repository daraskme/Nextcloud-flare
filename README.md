# Next-cloud-flare

Cloudflare 上で動かすセルフホスト型ファイル管理アプリ。仕様は
[設計書](docs/DESIGN.md)、実装順序は [実装ブリーフ](docs/IMPLEMENTATION_BRIEF.md) を参照。

現在は **Phase 0 のローカル検証基盤と Phase 1 の一部**を実装済み。
52テーブルの migration、147経路の契約、ControlDO の epoch 復旧、Access JWT 検証・初回管理者登録・session 保存/失効、node read/create の認可基盤を追加しています。
ファイル管理、公開 API、Web UI はまだ利用できません。HTTP 経路は未有効化です。
詳細は [Foundation 実装契約](docs/FOUNDATION.md) を参照してください。

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
