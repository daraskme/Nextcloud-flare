# 一時 Cron Worker による ControlDO 復旧

ローカルの `getPlatformProxy` が Access 認証や preview 接続で止まる場合に使う。別 Worker `ncf-staging-control-recovery` は公開 route、Custom Domain、workers.dev、preview URL を持たない。1 分ごとの Cron だけで起動し、固定の service binding から staging Worker の `StagingControlOperator` を呼ぶ。target Worker の一時 gate が `true` の間だけ動作する。実行前に D1 の `control` が想定した空の初回状態で、BACKUPS の epoch 履歴が空であることを再確認する。

Cron は毎回 D1 の初回状態を読み取り、epoch が 1 または 2、users/spaces/nodes/blobs/shares がすべて 0 であるときだけ `recover()` を呼ぶ。epoch 1 では maintenance/GC が停止していることも要求する。`recover()` の結果が epoch 2 以外なら止まる。監査がなければ開始する。1 回で最大 8 ページ、各ページ最大 20 件を検査し、次の Cron で保存済み cursor から続ける。監査完了後だけ admission を開き、次に GC を再開する。admission が既に開いて GC だけ停止していれば GC だけ再開する。両方開いた後の tick は状態を読むだけで終わる。各 tick の短い進捗を Worker logs に出す。失敗は短いコードだけを記録し、次の tick で再試行する。

## 配備と確認

Cloudflare account ID/API token を保護された環境変数から読み込む。値をコマンド引数やログに出さない。まず target Worker を最新コード・`STAGING_CONTROL_OPERATOR_ENABLED=true` で配備し、`EPOCH_FLOOR=2` と必要な Worker secrets があることを確認する。target の公開 HTTP route や Access policy は変えない。

```sh
node ops/staging/staging-config.mjs operator-enable
pnpm exec wrangler deploy --config ops/staging/wrangler.staging.generated.jsonc
node ops/staging/control-cron-config.mjs
pnpm exec wrangler deploy --dry-run --config ops/staging/control-cron.generated.jsonc
pnpm exec wrangler deploy --config ops/staging/control-cron.generated.jsonc
```

Cron 用 generated config は repository では追跡されず mode 0600。generator は account ID 以外を固定し、違う Worker 名や service、追加 route を受け付けない。`wrangler deploy` の出力で worker 名が `ncf-staging-control-recovery`、service binding が `next-cloud-flare-staging`、Cron が 1 件であることを照合する。

Cloudflare Workers logs または `wrangler tail ncf-staging-control-recovery` で `epoch`、`stage`、`pages` を見る。ログには個々の利用者 ID、secret、監査 cursor を出さない。remote D1 の control 行が `epoch=2,maintenance=0,gc_paused=0` になり、BACKUPS に `sys/epoch/2.json` が存在することを確認する。epoch が異なる場合はその値に基づき原因を調べ、手で D1 を修正しない。

```sh
pnpm exec wrangler d1 execute ncf-staging --remote --config ops/staging/wrangler.staging.generated.jsonc --command "SELECT epoch,maintenance,gc_paused FROM control WHERE singleton=1"
```

## 終了

確認できたら Cron Worker を**先に削除**する。対象名と config を明示し、`--force` は使わない。削除結果を確認した後、target の gate を無効にして再配備する。削除で止まった場合も gate を無効にして Cron の RPC 権限を閉じ、残った Worker の削除を続ける。

```sh
pnpm exec wrangler delete ncf-staging-control-recovery --config ops/staging/control-cron.generated.jsonc
node ops/staging/staging-config.mjs operator-disable
pnpm exec wrangler deploy --config ops/staging/wrangler.staging.generated.jsonc
```

この一時 Worker 自体は D1、R2、Queue の binding を持たず、任意 SQL や epoch bump を実行できない。公開 HTTP 呼出しは 404 を返す。Cloudflare の [named entrypoint](https://developers.cloudflare.com/workers/runtime-apis/bindings/service-bindings/rpc/#named-entrypoints) を使った production service binding であり、ローカル remote binding の preview tunnel は使わない。
