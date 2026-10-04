# Cloudflare staging 配備

環境ごとの現在revisionと配備状態の正本は[環境状態表](../../docs/ENVIRONMENT_STATUS.md)。このREADMEはstagingの運用手順と日付付き配備記録を扱い、revision情報を重複管理しない。以下の構築経緯は2026-10-03時点の記録で、`wrangler.staging.example.jsonc` はレビュー用の独立した設定である。D1 と KV の ID は意図的に無効な値にしてある。2026-10-03 時点で `darask.date` の専用リソース、52 件の D1 migration、Worker secret、Access policy、初回 deploy、ControlDO 復旧は完了した。匿名の HTTP smoke 9 件も通過した。管理者 1 人と招待された一般利用者 2 人の Access ログインを実環境で確認済み。D1 は利用者 3 人、所有者とルートがそれぞれ異なる個人スペース 3 件、消費済み招待 2 件、保留中招待 0 件だった。限定 CI token による preflight と Worker deploy も成功した。利用者による手動試験でアップロード・ダウンロードと、別アカウントのファイルが一覧に出ないことを確認済み。別利用者のファイル ID を指定した直接アクセスの拒否は別途確認する。`.github/workflows/staging.yml` は手動起動の preflight と明示 input 時だけの deploy を定義する。ローカル `wrangler.jsonc` と同じ Worker entry、compatibility date、binding、毎分 Cron、primary Queue と DLQ の consumer 設定を使用する。

## 2026-10-04 staging配備・検証記録

この配備checkpointの正確なrevisionは[環境状態表](../../docs/ENVIRONMENT_STATUS.md)を参照する。復元時の共有迂回防止修正とPR #37の統合作業は検証中で、stagingへは未配備。

`785faf3` の暗号化レビュー修正をstagingへ反映済み（Worker `654609ce-781a-4e0d-98d7-b047c280bb4c`、0054適用、53 migrations・86通常table・174 routes）。所有者署名、管理者鍵照合、検証済みblobマーカー、サーバーでの暗号化必須と迂回拒否を導入した。実管理者の既存3件は、64,932,182 bytesを全復号して以前のSHA-256と照合してから署名と管理者receiptを追加。実画面の画像表示・音声/動画再生・seek、新規v2 uploadと平文拒否も成功した。

暗号化修正の検証はNode918件、Workerd2,270件、browser48件成功（外部media未指定2件skip）、86-table backup drill成功。GitHub Actions [37162606409](https://github.com/daraskme/Nextcloud-flare/actions/runs/37162606409)（785faf3）と[37163402437](https://github.com/daraskme/Nextcloud-flare/actions/runs/37163402437)（Cron待機修正4acd5bd）はそれぞれ全5 job成功。`3566415` でデスクトップ通知のbusctl引数を修正し、設置済みruntimeへ適用した。

週次暗号化バックアップと毎時monitorを設置済み。初回世代 `e4312702-1f92-4b9b-aff9-35f84a84d5f2` / epoch2 は2026-10-04 09:28:25 JSTに完了した。外付けの暗号化アーカイブ131,145,497 bytesから独立したローカルSQLiteとファイル領域へ実際に復元し、86 tables・19 objects（130,603,898 bytes）を検証。復元した画像・音声・動画3件の全復号SHA-256も以前の記録と一致し、所有者署名・管理者receipt・markerを確認した。検証用の復元データと定期処理の作業コピーは削除済み。復旧JSONは元の端末内に保持し、Cloudflareや定期処理へ保存していない。

保存先は `/run/media/hiroshi/ボリューム/Nextcloudflare-backups`、毎週日曜03:30 JST（次回2026-10-11）。ユーザーsession再開時の取り逃し実行と、失敗時の同じ世代からの再試行に対応する。完了後のremote receiptはcompleted/released、maintenance・gc_paused・backup_frozenは0、一時bridgeは削除済み。`BACKUP_OPERATOR_ENABLED=true`、`CLIENT_ENCRYPTION_REQUIRED=true`、`STAGING_CONTROL_OPERATOR_ENABLED=false`、GitHub staging Environmentの`STAGING_WEEKLY_BACKUP_ENABLED=true`を確認した。

デスクトップ通知2件、重複抑止（重複0件・pending 0件）、バックアップ正常復帰通知1件の送達を確認。monitorはbackup healthy・live reachable・pending 0件。Billing APIの結果は`unattributed_below_threshold`で、アカウント全体の請求からstaging追加費用を厳密に分離できない。費用通知は月1万円で自動停止する仕組みではない。

### 過去のデプロイ・試験記録

以下のversion IDと状態は、それぞれの記録時点の履歴であり、現行versionやbackup完了を示すものではない。

## 2026-10-04 暗号化・復元試験の反映

当時のWorker versionは`3aafb739-ae57-449c-aff1-57fd389fdaea`。ブラウザーの本人＋管理者暗号化を配備し、`CLIENT_ENCRYPTION_REQUIRED=true`、両operator gateはfalseを維持する。匿名HTTP smoke 9件、公開SW bootstrapのscope/no-store、実Chromeの登録と未設定upload拒否を確認した。実ChromeはSW取得時にAccess Cookieを送らないため、鍵・データを含まない単一コードだけを既存の`/public-assets/*` Bypassで配信する。Private APIと内容取得の認証は維持し、新しいBypassは追加しない。

実管理者の保存済み鍵で既存メディア3件・64,932,182 bytesの暗号化コピーを作成し、実stagingで元データと復号後の全byte/SHA-256、表示・再生・seekを確認した。承認後、元の平文3件をtrash/purgeし、元nodeの404・ゴミ箱不在・暗号化コピー保持を確認した。R2原本は35日以上のGC猶予で残り、過去バックアップも保持中。一般利用者2人は使わないとのユーザー指示により、鍵設定と各1件の空ファイル移行を今回の対象から除外した。現在の運用対象は管理者1人。[初回設定](../../docs/CLIENT_ENCRYPTION_SETUP.md)を参照する。WebDAV・公開upload・直接APIは暗号化経路ではない。今回の実R2/SQLite/原本複写の復元試験、動画8回シーク、automation GET 2経路の状況は[進捗表](../../docs/IMPLEMENTATION_STATUS.md)に記録した。

## 2026-10-03 管理者閲覧・メディア再生の反映

Worker version `02bf2b69-a687-42a4-a1ad-9855a8fd2ea6` に、監査付きの読み取り専用管理画面 `/admin/files` とMP3/Opus/AV1の解析・配信修正を配備した。限定CI tokenによる配備後、匿名HTTP smokeは9件すべて成功した。管理画面の操作は [ADMIN_FILES](../../docs/ADMIN_FILES.md) を参照する。

D1は適用前の50 migrations・458 triggers・管理者用tableなしを照合し、ローカルSQLiteで検証した `0052_admin_browse.sql` と `0053_media_mime_backfill.sql` をmigration記録とともに `/import` 経由で一度だけ適用した。適用後は52 migrations・464 triggers・管理者用2 table、未適用migrationなし、記録の重複なし、foreign key違反なし。epoch 2、maintenance/gc_paused/backup_frozenはいずれも0を確認した。MIME backfillはcurrentの成功済み旧projectionに一致するoctet-streamだけを更新し、未解析の既存ファイルを自動再解析するものではない。

ローカルChrome 153で全ブラウザー45件が成功し、MP3、Opus Ogg/WebM/MP4、AV1+Opus WebM/MP4を通常画面と管理者プレビューで実再生した。実Cloudflare上の新しい管理者画面・メディア再生については、本人のログイン済みブラウザーでの追加確認を待っている。試験の範囲は [MEDIA_FORMATS](../../docs/MEDIA_FORMATS.md) に記録する。

## リソース台帳と設定

| 項目 | staging 専用値・確認事項 |
| --- | --- |
| Worker | `next-cloud-flare-staging`; `workers_dev=false`, `preview_urls=false` |
| Custom Domain | `staging-app.darask.date`, `staging-content.darask.date`; 両方とも同じ Worker の origin |
| D1 | `ncf-staging`; 2026-10-03の台帳記録では52件のmigration。現行の適用件数は[環境状態表](../../docs/ENVIRONMENT_STATUS.md)を参照。実 UUID は生成した非追跡 config と GitHub Environment variable に設定 |
| R2 | private `ncf-staging-blobs`, private `ncf-staging-backups`; public access と `r2.dev` を無効化 |
| KV | staging 専用 `CACHE` namespace ID |
| Durable Objects | staging Worker に属する `CONTROL`, `LOCKS`, `UPLOADS`, `BUDGETS`; `v1-sqlite-do` migration |
| Queues | `ncf-staging-jobs` と `ncf-staging-jobs-dlq`; primary の DLQ 指定と両 consumer を確認 |
| その他 | `ASSETS`, `IMAGES`, 3 種の rate limiting binding（3 つの `namespace_id` が account 内の他 Worker と重複しないことを確認）、毎分 Cron |
| Access | private user と service 用の staging 専用 application / audience / policy |

本番・ローカルと D1、R2、KV、Queues、Access audience、署名鍵を共有しない。Cloudflare の [Custom Domains](https://developers.cloudflare.com/workers/configuration/routing/custom-domains/) は Worker 自体を origin にする設定である。通常の Routes は既存 origin を前提にするため、この案では使わない。設定ファイル内のパスは `ops/staging/` からの相対パス。Wrangler の [environment 設定](https://developers.cloudflare.com/workers/wrangler/environments/)では vars や bindings が非継承なので、この案は `env.staging` ではなく完全な別設定にした。

`vars` は staging marker、厳密な HTTPS origin、Queue 名、PBKDF2 反復回数だけを置く。`secrets.required` は必要なキー名の一覧であり、値の登録や実在を証明しない。値はリポジトリや CI ログに書かず、staging 専用の保護された secret store で管理する。`ACCESS_ISSUER`, `ACCESS_USER_AUDIENCE`, `ACCESS_SERVICE_AUDIENCE` は実際の Access application と一致させる。`BOOTSTRAP_OWNER_EMAILS` は JSON 文字列配列、`BOOTSTRAP_OWNER_IDENTITIES` は `iss`/`sub` の JSON オブジェクト配列、`BOOTSTRAP_QUOTA_BYTES` は非負の安全な整数。両 bootstrap 配列の合計は 1 件以上。CSRF、content ticket/cookie、cursor、app/share password、upload capability は用途別の key ring と active kid を揃える。`R2_INVENTORY_*` は `ncf-staging-blobs` の読み取り専用 S3 inventory 資格情報を指定する。追加の jurisdiction が必要なら `R2_INVENTORY_JURISDICTION` を明示する。

`EPOCH_FLOOR=2` は初回 ControlDO 復旧後の安全な下限であり、通常配備にも残す。CIで生成する config の `STAGING_CONTROL_OPERATOR_ENABLED` は常に `false`。`BACKUP_OPERATOR_ENABLED` は GitHub Environment variable `STAGING_WEEKLY_BACKUP_ENABLED` から生成し、未設定・空欄・`false` は無効、文字列 `true` の場合だけ有効にする。不正な値は生成を拒否する。週次 backup runner を運用する間はこの variable を `true` に設定することで、次回の CI 配備でも gate が維持される。未設定のままなら従来どおり無効になる。backup operator の遠隔scheduleと資格情報は、現行CIのbackup drillだけでは構成されない。

## Access とアプリの入口

| host / path | Access policy | Worker 側 |
| --- | --- | --- |
| app host の `/*`（深い SPA path、`/private-assets/*`、private `/api/v1/*` を含む） | staging user application の root Allow | user JWT と既存 user/session |
| app の `/api/v1/automation/*` | 現在は Everyone を Deny。運用principal登録後に限定した Service Auth を設定 | nodes一覧・詳細のGETのみ実装済み。専用principal/root/scope/credential/epochを再検査 |
| app の `/s`, `/s/*`, `/public-assets/*`, `/api/v1/public/shares/*` | Bypass | share secret、session、CSRF、route manifest |
| app の `/dav`, `/dav/*` | Bypass | app password Basic |
| content host 全体 | Bypass | content ticket/cookie、host と route 検証 |

app host の root Allow は `staging-app.darask.date/*` で深い SPA path も覆い、public share と DAV にはより具体的な Bypass、automation には Deny application を設定した。Access の path 優先順位と Worker route の双方で、未知 method/path が private 権限に繰り上がらないことを確認する。content host に user Access を要求すると、別 origin の ticket/cookie flow が成立しない。実装済みautomation GET 2経路はServiceAuth専用で、一般利用者のAccess sessionでは利用できない。運用principalは未登録で、stagingでの実利用はまだ有効化していない。

**追加ユーザー:** `bootstrapOwner` は最初の管理者 1 人だけを作る。Access Allow に複数メールを登録した後、管理者がアプリの設定画面から各メールを招待する。7日間有効な招待は Access が検証した正確な issuer・メール表記と一致する本人の初回ログインで一度だけ消費され、`iss+sub` と専用 space/root を原子的に固定する。一般利用者の初期 quota は1 GiB。Access Allow だけではアプリ利用者にならず、D1 への手動 `INSERT` や暗黙のメール一致登録は行わない。初回管理者と招待後の一般利用者 2 人の実ログインは確認済み。手順は [STAGING_ACCESS](../../docs/STAGING_ACCESS.md) を参照する。

## 初回準備と手動配備

初回 Worker がない状態からのリソース作成、ID 取得、remote D1 migration、Worker secret の準備と同時登録は [INITIAL_PROVISION](INITIAL_PROVISION.md) に記載した。宣言的な resource plan は `node ops/staging/bootstrap-plan.mjs` でローカル表示できる。このコマンド自体は Cloudflare に接続しない。

初回 deploy 後の `503 not_ready` は [CONTROL_CRON_RECOVERY](CONTROL_CRON_RECOVERY.md) の一時 Cron Worker で復旧済み。D1 は epoch 2、受付と GC が有効、BACKUPS に `sys/epoch/2.json` がある。一時 Cron Worker は削除し、通常の generated config では operator gate を無効にした。[CONTROL_RECOVERY](CONTROL_RECOVERY.md) はローカル service binding が使える環境向けの別手順。

1. Cloudflare account と zone、上表の staging 専用リソース、Access application/policy、secret 名と値の管理責任者を確定する。D1/KV の実 ID、Queue と bucket の実在、Custom Domain の zone 所属、公開設定を台帳で照合する。`REPLACE_WITH_` が残る設定は拒否する。
2. GitHub repository の **Settings → Environments → New environment** で `staging` を作り、必要な reviewer と配備可能 branch を `main` に制限する。現環境では Environment の custom branch policy を `main` のみに設定済み。`staging` environment secrets に `CLOUDFLARE_ACCOUNT_ID` と限定 `CLOUDFLARE_API_TOKEN`、environment variables に実 ID の `STAGING_D1_DATABASE_ID` と `STAGING_KV_NAMESPACE_ID` を登録する。週次 backup gate を通常配備後も有効に保つ場合は、同じ environment variable に `STAGING_WEEKLY_BACKUP_ENABLED=true` を追加する。未設定ならfalseで生成される。CI token は `next-cloud-flare-staging` の Individual Workers Editor、`darask.date` の Workers Routes Read/Write、Account `darask` の Queues Read/Write を持つ。Wrangler は Queue consumer を含む deploy 時に Queue 一覧を取得するため、Workers Editor と Routes 権限だけでは認証エラーになった。secret 値は workflow file や通常の repository variables へ転記しない。workflow 自体も `main` 以外を拒否し、同時実行を 1 件に制限する。PR や一般の push job に Cloudflare 資格情報を渡さない。
3. 初回実行前に [INITIAL_PROVISION](INITIAL_PROVISION.md) に沿って staging リソースと Access を用意し、remote D1 migration の差分と復旧手順を確認して適用する。Worker の必要 secret は保護された一時 file から初回 `wrangler deploy --secrets-file` と同時に登録し、`wrangler secret list` で名前を照合する。この workflow は既存 Worker の secret list が成功することを前提にし、初回 Worker 作成・secret 投入・migration は行わない。[`wrangler secret put`](https://developers.cloudflare.com/workers/configuration/secrets/) は新 version を即時 deploy するため、初回登録には使わない。
4. GitHub Actions の **Staging preflight and deploy → Run workflow** で `main` を選び、まず `deploy=false` で実行する。workflow は環境 ID の形式・placeholder を検査し、gitignored の設定ファイルを生成して `pnpm check` を通し、Environment secret で Wrangler を認証して Worker の secret 名を照合する。`deploy=true` を明示した実行のみ `wrangler deploy` に進む。[Wrangler deploy](https://developers.cloudflare.com/workers/wrangler/configuration/#secrets) も `secrets.required` に挙げた secret の未設定を検出する。値の形式・Access audience との一致、Cloudflare resource や Access policy の正確さは別途人が確認する。
5. staging deploy 後に両 host の正しい dispatch、Access user/Bypass、automation route の未認証要求が拒否されること、private R2、初期化済み D1 と ControlDO、Queue と DLQ、Cron、Images、rate limiter、backup 経路を実環境で smoke test する。小さい fixture と少数リクエストに限定し、失敗時は traffic を止めて復旧状態を確認する。

Cloudflare の [GitHub Actions 配備手順](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/)は非対話の Wrangler に account ID と API token を使用する。[Workers 権限表](https://developers.cloudflare.com/workers/authorization/)では既存 Worker の deploy は対象 Worker の Editor、新規 Worker 作成は Workers product の Admin、Custom Domain 変更は対象 zone の Workers Routes Write も要る。D1 の直接 migration と staging resource 作成にはそれぞれ別の権限が要るため、初回 provision と継続 deploy の token は用途別に分ける。

## 費用の上限

運用予算は**staging の追加費用で月 1 万円**。Cloudflare の [Budget alerts](https://developers.cloudflare.com/billing/manage/budget-alerts/)は Pay-as-you-go アカウントで利用できる USD 建て・account 全体対象の通知で、上限到達時も使用を停止しない。staging 単独の強制上限としては使えない。配備前に既存アカウントの課金基準値と staging 専用リソースの使用量を記録し、追加分の月額見込みが1万円以内であることを確認する。追加費用の予測が検証できるまでは小さい fixture、低頻度の手動検証、少量の R2/Images/Queue 処理だけにする。利用可能な場合は account 全体の通知閾値を適切に設定し、Cloudflare Usage/Billing と staging 向けリソースの使用量を日次で照合する。Queue 再試行・DLQ、毎分 Cron、Images 変換、R2 保存/転送、D1 と Workers の実使用量を監視し、当月の追加費用と残日数から見積もる月末額が1万円に達する見込みなら、負荷試験と配備を止めて原因を確認する。Budget alerts を費用の強制停止装置として扱わない。

費用見積もりと日次確認の具体的な手順は [STAGING_COST](../../docs/STAGING_COST.md) を参照する。
