# Cloudflare staging 配備

`wrangler.staging.example.jsonc` はレビュー用の独立した設定である。D1 と KV の ID は意図的に無効な値にしてある。2026-10-03 時点で `darask.date` の専用リソース、52 件の D1 migration、Worker secret、Access policy、初回 deploy、ControlDO 復旧は完了した。匿名の HTTP smoke 9 件も通過した。管理者 1 人と招待された一般利用者 2 人の Access ログインを実環境で確認済み。D1 は利用者 3 人、所有者とルートがそれぞれ異なる個人スペース 3 件、消費済み招待 2 件、保留中招待 0 件だった。限定 CI token による preflight と Worker deploy も成功した。利用者による手動試験でアップロード・ダウンロードと、別アカウントのファイルが一覧に出ないことを確認済み。別利用者のファイル ID を指定した直接アクセスの拒否は別途確認する。`.github/workflows/staging.yml` は手動起動の preflight と明示 input 時だけの deploy を定義する。ローカル `wrangler.jsonc` と同じ Worker entry、compatibility date、binding、毎分 Cron、primary Queue と DLQ の consumer 設定を使用する。

## 2026-10-03 管理者閲覧・メディア再生の反映

Worker version `02bf2b69-a687-42a4-a1ad-9855a8fd2ea6` に、監査付きの読み取り専用管理画面 `/admin/files` とMP3/Opus/AV1の解析・配信修正を配備した。限定CI tokenによる配備後、匿名HTTP smokeは9件すべて成功した。管理画面の操作は [ADMIN_FILES](../../docs/ADMIN_FILES.md) を参照する。

D1は適用前の50 migrations・458 triggers・管理者用tableなしを照合し、ローカルSQLiteで検証した `0052_admin_browse.sql` と `0053_media_mime_backfill.sql` をmigration記録とともに `/import` 経由で一度だけ適用した。適用後は52 migrations・464 triggers・管理者用2 table、未適用migrationなし、記録の重複なし、foreign key違反なし。epoch 2、maintenance/gc_paused/backup_frozenはいずれも0を確認した。MIME backfillはcurrentの成功済み旧projectionに一致するoctet-streamだけを更新し、未解析の既存ファイルを自動再解析するものではない。

ローカルChrome 153で全ブラウザー45件が成功し、MP3、Opus Ogg/WebM/MP4、AV1+Opus WebM/MP4を通常画面と管理者プレビューで実再生した。実Cloudflare上の新しい管理者画面・メディア再生については、本人のログイン済みブラウザーでの追加確認を待っている。試験の範囲は [MEDIA_FORMATS](../../docs/MEDIA_FORMATS.md) に記録する。

## リソース台帳と設定

| 項目 | staging 専用値・確認事項 |
| --- | --- |
| Worker | `next-cloud-flare-staging`; `workers_dev=false`, `preview_urls=false` |
| Custom Domain | `staging-app.darask.date`, `staging-content.darask.date`; 両方とも同じ Worker の origin |
| D1 | `ncf-staging`; 52 件の migration 適用済み。実 UUID は生成した非追跡 config と GitHub Environment variable に設定 |
| R2 | private `ncf-staging-blobs`, private `ncf-staging-backups`; public access と `r2.dev` を無効化 |
| KV | staging 専用 `CACHE` namespace ID |
| Durable Objects | staging Worker に属する `CONTROL`, `LOCKS`, `UPLOADS`, `BUDGETS`; `v1-sqlite-do` migration |
| Queues | `ncf-staging-jobs` と `ncf-staging-jobs-dlq`; primary の DLQ 指定と両 consumer を確認 |
| その他 | `ASSETS`, `IMAGES`, 3 種の rate limiting binding（3 つの `namespace_id` が account 内の他 Worker と重複しないことを確認）、毎分 Cron |
| Access | private user と service 用の staging 専用 application / audience / policy |

本番・ローカルと D1、R2、KV、Queues、Access audience、署名鍵を共有しない。Cloudflare の [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) は Worker 自体を origin にする設定である。通常の Routes は既存 origin を前提にするため、この案では使わない。設定ファイル内のパスは `ops/staging/` からの相対パス。Wrangler の [environment 設定](https://developers.cloudflare.com/workers/wrangler/environments/)では vars や bindings が非継承なので、この案は `env.staging` ではなく完全な別設定にした。

`vars` は staging marker、厳密な HTTPS origin、Queue 名、PBKDF2 反復回数だけを置く。`secrets.required` は必要なキー名の一覧であり、値の登録や実在を証明しない。値はリポジトリや CI ログに書かず、staging 専用の保護された secret store で管理する。`ACCESS_ISSUER`, `ACCESS_USER_AUDIENCE`, `ACCESS_SERVICE_AUDIENCE` は実際の Access application と一致させる。`BOOTSTRAP_OWNER_EMAILS` は JSON 文字列配列、`BOOTSTRAP_OWNER_IDENTITIES` は `iss`/`sub` の JSON オブジェクト配列、`BOOTSTRAP_QUOTA_BYTES` は非負の安全な整数。両 bootstrap 配列の合計は 1 件以上。CSRF、content ticket/cookie、cursor、app/share password、upload capability は用途別の key ring と active kid を揃える。`R2_INVENTORY_*` は `ncf-staging-blobs` の読み取り専用 S3 inventory 資格情報を指定する。追加の jurisdiction が必要なら `R2_INVENTORY_JURISDICTION` を明示する。

`EPOCH_FLOOR=2` は初回 ControlDO 復旧後の安全な下限であり、通常配備にも残す。`STAGING_CONTROL_OPERATOR_ENABLED` は通常 `false`。`BACKUP_OPERATOR_ENABLED` は別の backup operator Worker の設定であり、この app Worker では設定しない。backup operator の遠隔 schedule と資格情報も、現行 CI の backup drill だけでは構成されない。

## Access とアプリの入口

| host / path | Access policy | Worker 側 |
| --- | --- | --- |
| app host の `/*`（深い SPA path、`/private-assets/*`、private `/api/v1/*` を含む） | staging user application の root Allow | user JWT と既存 user/session |
| app の `/api/v1/automation/*` | 現在は Everyone を Deny。実装後は Service Auth を設計 | 現行 Worker に handler はなく、404。service API は未実装 |
| app の `/s`, `/s/*`, `/public-assets/*`, `/api/v1/public/shares/*` | Bypass | share secret、session、CSRF、route manifest |
| app の `/dav`, `/dav/*` | Bypass | app password Basic |
| content host 全体 | Bypass | content ticket/cookie、host と route 検証 |

app host の root Allow は `staging-app.darask.date/*` で深い SPA path も覆い、public share と DAV にはより具体的な Bypass、automation には Deny application を設定した。Access の path 優先順位と Worker route の双方で、未知 method/path が private 権限に繰り上がらないことを確認する。content host に user Access を要求すると、別 origin の ticket/cookie flow が成立しない。Service Auth は将来の automation route の入口契約であり、現行 Worker に service API はない。

**追加ユーザー:** `bootstrapOwner` は最初の管理者 1 人だけを作る。Access Allow に複数メールを登録した後、管理者がアプリの設定画面から各メールを招待する。7日間有効な招待は Access が検証した正確な issuer・メール表記と一致する本人の初回ログインで一度だけ消費され、`iss+sub` と専用 space/root を原子的に固定する。一般利用者の初期 quota は1 GiB。Access Allow だけではアプリ利用者にならず、D1 への手動 `INSERT` や暗黙のメール一致登録は行わない。初回管理者と招待後の一般利用者 2 人の実ログインは確認済み。手順は [STAGING_ACCESS](../../docs/STAGING_ACCESS.md) を参照する。

## 初回準備と手動配備

初回 Worker がない状態からのリソース作成、ID 取得、remote D1 migration、Worker secret の準備と同時登録は [INITIAL_PROVISION](INITIAL_PROVISION.md) に記載した。宣言的な resource plan は `node ops/staging/bootstrap-plan.mjs` でローカル表示できる。このコマンド自体は Cloudflare に接続しない。

初回 deploy 後の `503 not_ready` は [CONTROL_CRON_RECOVERY](CONTROL_CRON_RECOVERY.md) の一時 Cron Worker で復旧済み。D1 は epoch 2、受付と GC が有効、BACKUPS に `sys/epoch/2.json` がある。一時 Cron Worker は削除し、通常の generated config では operator gate を無効にした。[CONTROL_RECOVERY](CONTROL_RECOVERY.md) はローカル service binding が使える環境向けの別手順。

1. Cloudflare account と zone、上表の staging 専用リソース、Access application/policy、secret 名と値の管理責任者を確定する。D1/KV の実 ID、Queue と bucket の実在、Custom Domain の zone 所属、公開設定を台帳で照合する。`REPLACE_WITH_` が残る設定は拒否する。
2. GitHub repository の **Settings → Environments → New environment** で `staging` を作り、必要な reviewer と配備可能 branch を `main` に制限する。現環境では Environment の custom branch policy を `main` のみに設定済み。`staging` environment secrets に `CLOUDFLARE_ACCOUNT_ID` と限定 `CLOUDFLARE_API_TOKEN`、environment variables に実 ID の `STAGING_D1_DATABASE_ID` と `STAGING_KV_NAMESPACE_ID` を登録済み。CI token は `next-cloud-flare-staging` の Individual Workers Editor、`darask.date` の Workers Routes Read/Write、Account `darask` の Queues Read/Write を持つ。Wrangler は Queue consumer を含む deploy 時に Queue 一覧を取得するため、Workers Editor と Routes 権限だけでは認証エラーになった。secret 値は workflow file や通常の repository variables へ転記しない。workflow 自体も `main` 以外を拒否し、同時実行を 1 件に制限する。PR や一般の push job に Cloudflare 資格情報を渡さない。
3. 初回実行前に [INITIAL_PROVISION](INITIAL_PROVISION.md) に沿って staging リソースと Access を用意し、remote D1 migration の差分と復旧手順を確認して適用する。Worker の必要 secret は保護された一時 file から初回 `wrangler deploy --secrets-file` と同時に登録し、`wrangler secret list` で名前を照合する。この workflow は既存 Worker の secret list が成功することを前提にし、初回 Worker 作成・secret 投入・migration は行わない。[`wrangler secret put`](https://developers.cloudflare.com/workers/configuration/secrets/) は新 version を即時 deploy するため、初回登録には使わない。
4. GitHub Actions の **Staging preflight and deploy → Run workflow** で `main` を選び、まず `deploy=false` で実行する。workflow は環境 ID の形式・placeholder を検査し、gitignored の設定ファイルを生成して `pnpm check` を通し、Environment secret で Wrangler を認証して Worker の secret 名を照合する。`deploy=true` を明示した実行のみ `wrangler deploy` に進む。[Wrangler deploy](https://developers.cloudflare.com/workers/wrangler/configuration/#secrets) も `secrets.required` に挙げた secret の未設定を検出する。値の形式・Access audience との一致、Cloudflare resource や Access policy の正確さは別途人が確認する。
5. staging deploy 後に両 host の正しい dispatch、Access user/Bypass、未実装の automation route が 404 になること、private R2、初期化済み D1 と ControlDO、Queue と DLQ、Cron、Images、rate limiter、backup 経路を実環境で smoke test する。小さい fixture と少数リクエストに限定し、失敗時は traffic を止めて復旧状態を確認する。

Cloudflare の [GitHub Actions 配備手順](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)は非対話の Wrangler に account ID と API token を使用する。[Workers 権限表](https://developers.cloudflare.com/workers/authorization/)では既存 Worker の deploy は対象 Worker の Editor、新規 Worker 作成は Workers product の Admin、Custom Domain 変更は対象 zone の Workers Routes Write も要る。D1 の直接 migration と staging resource 作成にはそれぞれ別の権限が要るため、初回 provision と継続 deploy の token は用途別に分ける。

## 費用の上限

運用予算は**staging の追加費用で月 1 万円**。Cloudflare の [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)は Pay-as-you-go アカウントで利用できる USD 建て・account 全体対象の通知で、上限到達時も使用を停止しない。staging 単独の強制上限としては使えない。配備前に既存アカウントの課金基準値と staging 専用リソースの使用量を記録し、追加分の月額見込みが1万円以内であることを確認する。追加費用の予測が検証できるまでは小さい fixture、低頻度の手動検証、少量の R2/Images/Queue 処理だけにする。利用可能な場合は account 全体の通知閾値を適切に設定し、Cloudflare Usage/Billing と staging 向けリソースの使用量を日次で照合する。Queue 再試行・DLQ、毎分 Cron、Images 変換、R2 保存/転送、D1 と Workers の実使用量を監視し、当月の追加費用と残日数から見積もる月末額が1万円に達する見込みなら、負荷試験と配備を止めて原因を確認する。Budget alerts を費用の強制停止装置として扱わない。

費用見積もりと日次確認の具体的な手順は [STAGING_COST](../../docs/STAGING_COST.md) を参照する。
