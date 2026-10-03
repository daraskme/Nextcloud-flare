# Staging 初回 provision 手順

この手順は初回 Worker が存在せず、`staging.yml` の `wrangler secret list` がまだ成功しない状態を埋める。`darask.date` の staging では専用リソース作成、初回50件のD1 migration、初回Worker配備まで完了した。追加migrationと最新の配備状況は [README](README.md) を参照し、再実行時は各リソースとmigrationの現状を先に照合する。リポジトリ内の `bootstrap-plan.mjs` は Cloudflare に接続せず、現行 template と一致するリソース名・作成コマンドだけを JSON で表示する。

```sh
node ops/staging/bootstrap-plan.mjs
```

作業は repository root で、lockfile に固定された Wrangler を使う。初回の resource 作成権限、Worker 作成権限、Custom Domain を追加する zone の Workers Routes Write、D1 migration 権限を、既存 deploy 用 token と分けて用意する。**最初の資格情報境界は次節の一覧取得・リソース作成**であり、Cloudflare account ID と API token が必要になる。値は secret manager から Wrangler 環境変数へ渡し、引数・ファイル名・コマンド履歴・CI ログに含めない。zone `darask.date` の所属と staging の月額追加費用見積もりを先に確認する。

## 1. 専用リソースを作る

plan にある名前を使い、既存リソースの有無を先に確認する。別用途の同名リソースがあれば流用せず作業を止める。資格情報が設定され次第、対象 account と費用見込みを確認して以下を実行する。`--no-update-config` はローカル `wrangler.jsonc` を書き換えないための指定である。

```sh
pnpm exec wrangler whoami
pnpm exec wrangler d1 list --json
pnpm exec wrangler kv namespace list
pnpm exec wrangler r2 bucket list
pnpm exec wrangler queues list

pnpm exec wrangler d1 create ncf-staging --no-update-config
pnpm exec wrangler kv namespace create ncf-staging-cache --no-update-config
pnpm exec wrangler r2 bucket create ncf-staging-blobs --no-update-config
pnpm exec wrangler r2 bucket create ncf-staging-backups --no-update-config
pnpm exec wrangler queues create ncf-staging-jobs-dlq
pnpm exec wrangler queues create ncf-staging-jobs
```

R2 の 2 bucket は public access / `r2.dev` を有効にしない。Queue と DLQ は名前を取り違えない。Rate Limiting の namespace ID `4001`–`4003` が account 内の他 Worker に使われていないことを確認する。初回調査で `2001`–`2003` は別 Worker が使用していた。Images binding、Workers Paid と R2/Queues/D1/KV の利用可否も配備前に確認する。

## 2. 実 ID を照合する

作成結果の ID を自由入力で転記する前に、対象 account で一覧を取得する。`inspect-ids` は**完全一致の名前が各 1 件**であることと ID の形式を検査するだけで、Cloudflare に接続しない。

```sh
pnpm exec wrangler d1 list --json > /tmp/ncf-staging-d1-list.json
pnpm exec wrangler kv namespace list > /tmp/ncf-staging-kv-list.json
node ops/staging/staging-config.mjs inspect-ids /tmp/ncf-staging-d1-list.json /tmp/ncf-staging-kv-list.json
```

表示された `STAGING_D1_DATABASE_ID` と `STAGING_KV_NAMESPACE_ID` を GitHub Environment `staging` の **variables** に登録する。ID は秘密値ではないが、一覧ファイルに他の account 資源名を含むため共有しない。`CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` は同 Environment の **secrets** に入れる。preview/local ID や別 account の ID は拒否する。Cloudflare account と Access application の一致は人が dashboard で確認する。

ローカルで生成 config を検査するときも、上記の実 ID を環境変数として渡す。

```sh
node ops/staging/staging-config.mjs generate
pnpm exec wrangler deploy --dry-run --config ops/staging/wrangler.staging.generated.jsonc
```

生成 config は `ops/staging/.gitignore` により追跡されない。作成コマンドを再実行する前に、同名のリソースを必ず一覧で再確認する。

## 3. Access と D1 を先に準備する

[Access runbook](../../docs/STAGING_ACCESS.md) の user Allow、app host の public/DAV Bypass、content host 全体の Bypass を設定し、誤った host/path が開かないことを確認する。automation Service Auth は将来の境界であり、現行 API は 404。Custom Domain の適用前にこの入口を用意する。

remote D1 migration は workflow から自動実行しない。生成 config の `DB` が `ncf-staging` の実 UUID を指すことを確認し、未適用ファイルをレビューしてから対話操作で適用する。Cloudflare の `d1 migrations apply` は非対話環境では確認を省くため、この操作を通常の CI step に入れない。

```sh
pnpm exec wrangler d1 migrations list ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc
pnpm exec wrangler d1 migrations apply ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc
```

`0003_invariant_guards.sql` など trigger を含む migration が `incomplete input: SQLITE_ERROR [code: 7500]` で失敗した場合、D1 の `/query` 経路で複数の trigger 文を分割する問題を回避するため、次の手順で **失敗した 1 ファイルだけ** `/import` 経路から適用する。`migrations apply` は migration 本文と `d1_migrations` への記録を 1 件の `/query` に送る。準備スクリプトは同じ記録を SQL の末尾に追加し、先行 migration を適用した SQLite で検証したうえで `/tmp` に `0600` のファイルを作る。Cloudflare には接続しない。

適用前に `migrations list` で対象が未適用で、その前の migration がすべて適用済みであることを確認する。特に `0003` では `0001` と `0002` のみが適用済みであることを確認する。対象の trigger が既に作成されていないかも確認する。予期しない状態なら実行せず調査する。

```sh
pnpm exec wrangler d1 migrations list ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc
pnpm exec wrangler d1 execute ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc --command "SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name;"
node ops/staging/prepare-d1-trigger-import.mjs 0003_invariant_guards.sql
```

出力された `path` と `sha256` を確認する。次の `<path>` は出力された絶対パスに置き換える。このコマンドは remote D1 を変更する。Cloudflare の [D1 import](https://developers.cloudflare.com/d1/best-practices/import-export-data/) は失敗時に DB を元の状態へ戻す。適用後は migration 記録と trigger 数を確認し、`0003` が 1 回だけ記録され、trigger が 30 個あることを確かめる。

```sh
pnpm exec wrangler d1 execute ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc --file <path>
pnpm exec wrangler d1 execute ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc --command "SELECT name, COUNT(*) AS n FROM d1_migrations GROUP BY name ORDER BY name;"
pnpm exec wrangler d1 execute ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc --command "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger';"
pnpm exec wrangler d1 migrations list ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc
```

後続 migration でも同じ `7500` が発生した場合は、その migration の前までが適用済みであることを確認し、ファイル名を指定して同じ準備・適用・検証を 1 件ずつ繰り返す。二重適用や migration 記録だけの手動追加はしない。

### 空の staging D1 で 0003 の適用後に残りをまとめて適用する

この方法は **0001–0003 だけが適用済み** の空の staging D1 に限る。`0004` から `0051` の 47 ファイルを番号順に連結し、各ファイルの直後に対応する `d1_migrations` 記録を入れる。準備スクリプトは先行 3 ファイルから連結 payload の終わりまでを SQLite で実行し、全記録と最終 trigger 数を検査する。既存の `0001`–`0003` は再実行しない。

まず remote の migration 記録が `0001_foundation.sql`、`0002_content_media.sql`、`0003_invariant_guards.sql` の各 1 件だけであり、trigger が 30 個であることを確認する。`migrations list` では `0004` から `0051` がすべて未適用である必要がある。異なる状態ならこの一括 import は実行しない。

```sh
pnpm exec wrangler d1 execute ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc --command "SELECT name, COUNT(*) AS n FROM d1_migrations GROUP BY name ORDER BY name;"
pnpm exec wrangler d1 execute ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc --command "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger';"
pnpm exec wrangler d1 migrations list ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc
node ops/staging/prepare-d1-trigger-import.mjs 0004_catalogue_indexes.sql 0051_access_invites.sql
```

準備結果が `precedingMigrations: 3`、`migrations: 47`、`expectedTotalMigrations: 50`、`expectedTotalTriggers: 458` であることを確認し、出力された `path` と `sha256sum <path>` の値を照合する。次の `<path>` を出力された絶対パスに置き換えて 1 回だけ実行する。

```sh
pnpm exec wrangler d1 execute ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc --file <path>
```

成功後、各 migration の `n` が 1、記録の総数が 50、trigger が 458、`migrations list` に未適用ファイルがないことを確認する。import が失敗した場合は再実行前に同じ照会を行い、部分適用や記録の欠落がないことを確認する。

```sh
pnpm exec wrangler d1 execute ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc --command "SELECT name, COUNT(*) AS n FROM d1_migrations GROUP BY name ORDER BY name;"
pnpm exec wrangler d1 execute ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc --command "SELECT COUNT(*) AS n FROM d1_migrations;"
pnpm exec wrangler d1 execute ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc --command "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger';"
pnpm exec wrangler d1 migrations list ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc
```

## 4. Worker 用 secret 値の登録

初回 Worker 配備には、staging 専用の Access issuer/audience、bootstrap owner、用途別 key ring、password pepper、R2 inventory 資格情報の**値**が必要になる。名前の完全な一覧は `node ops/staging/bootstrap-plan.mjs` の `requiredWorkerSecretNames` と `wrangler.staging.example.jsonc` の `secrets.required` にある。

| 値 | 取得・生成方法 |
| --- | --- |
| `ACCESS_ISSUER` | Cloudflare Access の team domain の HTTPS origin。末尾 `/` なし。実 JWT の `iss` と一致させる |
| `ACCESS_USER_AUDIENCE`, `ACCESS_SERVICE_AUDIENCE` | 対応する Access application の AUD tag を取得する。相互に異なる値にする。automation API は現在 404 だが service AUD 設定は Worker config の必須項目 |
| `BOOTSTRAP_OWNER_EMAILS`, `BOOTSTRAP_OWNER_IDENTITIES` | 最初の管理者の Access が返す正確な email を JSON 配列で指定するか、確認済み `iss`/`sub` を JSON 配列で指定する。使わない側は `[]`。他の tester はアプリから招待する |
| `BOOTSTRAP_QUOTA_BYTES` | 管理者の初期容量を非負整数で指定する。下書きは `1073741824`（1 GiB） |
| `CSRF_*`, `CONTENT_*`, `NODE_CURSOR_*`, `APP_PASSWORD_*`, `SHARE_PASSWORD_*`, `UPLOAD_CAPABILITY_*` | **用途ごとに別々の** 32 byte 暗号学的乱数を生成し、padding なし base64url（43文字）にする。各 `*_KEYS`/`*_PEPPERS` は `{"s1":"<43文字>"}` という JSON 文字列、対応する `*_ACTIVE_KID` は `s1`。ring 内の古い kid は稼働中 token/credential の失効まで保持する |
| `R2_INVENTORY_ACCOUNT_ID`, `R2_INVENTORY_BUCKET` | 対象 Cloudflare account の 32桁小文字hex ID と固定 bucket 名 `ncf-staging-blobs` |
| `R2_INVENTORY_ACCESS_KEY_ID`, `R2_INVENTORY_SECRET_ACCESS_KEY` | R2 dashboard で bucket `ncf-staging-blobs` に限定した **Object Read only** S3 API token を発行して得る 2 値。Secret Access Key は発行時だけ表示される。通常の Cloudflare deploy API token とは別物 |
| `R2_INVENTORY_JURISDICTION` | bucket が jurisdiction 固定なら `eu`/`fedramp`/`us` を追加。通常は省略して `default` |

秘密値を画面やログへ表示せずに用意するため、次のローカルツールが必要 secret 名の JSON 下書きを**repository 外の絶対パス**に mode `0600` で新規作成する。8 用途の乱数鍵は Node `crypto.randomBytes(32)` で互いに異なる値を生成し、Access/owner/R2 の入力欄は `FILL_` のままにする。既存ファイルは上書きしない。

```sh
node ops/staging/secret-file.mjs create /absolute/private/staging-worker-secrets.json
```

入力欄を secret manager から埋めた後、同じツールで名前・形式・鍵の重複を検査する。成功時も値は出力しない。`secrets.required` は deploy 時に登録の有無を検査するが、値の形式や Access audience と実 application の一致までは保証しない。

```sh
STAGING_SECRET_FILE=/absolute/private/staging-worker-secrets.json
node ops/staging/secret-file.mjs validate "$STAGING_SECRET_FILE"
```

secret file と保護済み Access、remote migration、resource ID を確認した後の**初回** Worker 配備は次の別操作となる。このコマンドは Custom Domain、Queue consumer、毎分 Cron を有効にする。

```sh
pnpm exec wrangler deploy --config ops/staging/wrangler.staging.generated.jsonc --secrets-file "$STAGING_SECRET_FILE"
```

`wrangler secret put` は直ちに新 version を deploy する。初回登録には使わず、上記の同時投入を使用する。投入後、`pnpm exec wrangler secret list --config ops/staging/wrangler.staging.generated.jsonc --format json` で名前だけを確認する。初回 deploy 後は `staging.yml` の `deploy=false` を実行して既存 Worker の全 required secret 名を照合し、問題がなければ `deploy=true` の後続配備を利用する。private file は secret manager の規則に沿って安全に削除する。remote 操作の結果と課金の観測値は [README](README.md) に定義した staging gate に記録する。

参照: [Wrangler D1](https://developers.cloudflare.com/workers/wrangler/commands/d1/)、[KV](https://developers.cloudflare.com/workers/wrangler/commands/kv/)、[R2](https://developers.cloudflare.com/r2/reference/wrangler-commands/)、[Queues](https://developers.cloudflare.com/queues/reference/wrangler-commands/)、[secret file](https://developers.cloudflare.com/workers/configuration/secrets/)、[Access JWT](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/application-token/)、[R2 S3 credentials](https://developers.cloudflare.com/r2/api/tokens/)。
