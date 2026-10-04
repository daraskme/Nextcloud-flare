# Staging ControlDO の初回復旧

staging の D1 migration と初回 Worker deploy が完了しても、ControlDO は自動初期化されない。`503 not_ready` は閉じた状態を示す。初回 D1 の `control.epoch=1`、`maintenance=1`、`gc_paused=1` と、BACKUPS bucket 内に epoch 履歴がないことを先に確認する。staging template の `EPOCH_FLOOR=2` はこの空の初回状態に対する明示的な下限である。既存データのある環境や別 Worker へこの手順を流用しない。

`StagingControlOperator` は named service binding の RPC だけを受ける。公開 HTTP の fetch は 404。対象 Worker の `ENVIRONMENT=staging`、`STAGING_CONTROL_OPERATOR_ENABLED=true`、binding props の purpose と environment がすべて一致しなければ拒否する。操作は recover、監査開始、20 件ずつの監査、監査後の admission と GC 再開だけに限定した。DB の任意 SQL、epoch bump、監査なしの受付再開は提供しない。

## 実行

操作の前に、別用途の backup/restore/maintenance が動いていないこと、D1 の migration が完了していること、staging の BACKUPS/BLOBS bindings が正しいことを確認する。`CLOUDFLARE_ACCOUNT_ID` と `CLOUDFLARE_API_TOKEN` は既存の保護された環境変数から渡す。値や env file を引数に書かない。

まず [INITIAL_PROVISION](INITIAL_PROVISION.md) の ID 照合に従い、`STAGING_D1_DATABASE_ID` と `STAGING_KV_NAMESPACE_ID` を設定して `node ops/staging/staging-config.mjs generate` を再実行する。古い generated config には `EPOCH_FLOOR` と一時ゲートがない場合がある。生成済みの ignored config だけで一時ゲートを有効にし、同じ config で再 deploy する。Worker secrets は保持されることを `wrangler secret list` で確認する。

```sh
node ops/staging/staging-config.mjs operator-enable
pnpm exec wrangler deploy --config ops/staging/wrangler.staging.generated.jsonc
pnpm exec wrangler secret list --config ops/staging/wrangler.staging.generated.jsonc
```

以下は 1 回ずつ実行し、表示された epoch を次の引数に使う。`recover` は pending 状態から再試行でき、既に ready の場合は同じ epoch を返す。応答喪失後は新しい epoch を推測せず、同じ `recover` を再実行する。

CLI が 45 秒以内に返らない場合は終了コード 124 と `staging_control_timeout_unknown_outcome` で停止する。これは操作取消を意味しない。`⎔ Establishing remote connection...` で止まるときは Wrangler の remote proxy 準備中で、ControlDO に届いた証拠はない。D1 の control 行と BACKUPS の epoch 履歴を読み取りで確認する。

```sh
node ops/staging/control.mjs recover
node ops/staging/control.mjs audit-start 2
node ops/staging/control.mjs audit-next 2
```

`audit-next` の `result.completed` が `true` になるまで、同じ epoch で繰り返す。1 回に 20 件を調べ、各ページの進捗は ControlDO に保存される。失敗したページでは停止し、原因を修正して同じ `audit-next` を再実行する。監査中に状態を修復した場合は `audit-start` からやり直す。監査が完了しなければ `resume` を実行しない。

```sh
node ops/staging/control.mjs resume 2
node ops/staging/control.mjs gc-resume 2
node ops/staging/control.mjs status
```

`status` が `maintenance:false,gcPaused:false` を返し、D1 の control 行も同じ epoch・停止解除になったことを確認する。`resume` は GC を停止したまま受付だけを開く。`gc-resume` は監査と受付再開を確認した後に実行する。Access 付き private URL と public URL の smoke test はその後に行う。

最後に生成済み config のゲートを無効へ戻して再 deploy し、ControlDO の正常状態が保たれることを確認する。再生成すると template の既定 `false` に戻る。将来の復旧時のみ同じ一時ゲートを明示的に有効化する。

```sh
node ops/staging/staging-config.mjs operator-disable
pnpm exec wrangler deploy --config ops/staging/wrangler.staging.generated.jsonc
```

この CLI は [Wrangler getPlatformProxy](https://developers.cloudflare.com/workers/wrangler/api/#getplatformproxy) で `next-cloud-flare-staging` の named entrypoint へ remote service binding を張る。生成する一時 Wrangler config は mode 0600 で、終了時に削除する。Cloudflare の呼出し元 Worker へこの binding を永続的に配らない。

## Remote proxy を利用できない場合

[Cloudflare の remote binding 説明](https://developers.cloudflare.com/workers/local-development/#connect-to-access-protected-workers)では、Access が Worker を保護している場合、Wrangler 側にも Access の認証が必要になる。現在の Access app では OTP による本人認証を使うため、preview session がこの境界で待っている可能性がある。これは推定であり、別の接続障害もあり得る。

一時 gate を閉じた後、公開 route と workers.dev を持たない別 Worker を Cron で一時配備する方法を使える。固定の production service binding から同じ named entrypoint を呼ぶので、ローカル remote proxy を通らない。詳細は [CONTROL_CRON_RECOVERY](CONTROL_CRON_RECOVERY.md)。
