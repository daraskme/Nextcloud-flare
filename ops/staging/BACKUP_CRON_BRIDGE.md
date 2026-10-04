# 一時 private Cron によるバックアップ操作

週次運用では `ops/backup/run-weekly.mjs --run` を使用する。新規世代だけ現行epochを読み取り、未完了世代は同じUUID・epochで再開する。設定とブリッジ本体はprivateな `workRoot/<UUID>/bridge/` に生成し、repo内の手動生成設定とは分ける。以下のコマンドは手動復旧・検証用で、定期処理と同時に実行しない。

`backup-cron.mjs`は公開HTTP routeを持たない一時Workerで、staging app Workerのprivate `BackupOperator` named entrypointへ固定UUID・保存済みepochで接続する。生成設定は`begin`、`complete`、`receipt`のいずれか一つだけを実行する。1分ごとのtickで`begin`は同じUUIDを再送し、`complete`は同じmanifest SHA-256で最大4 RPCを進める。応答不明や失敗時に`cancel`/`release`/自動thawは行わない。ログは操作と段階だけを記録する。

実行前に元D1の現行epoch、通常受付、他のbackupが無いことを読み取りで確認する。UUIDを保護された運用記録に保存する。`CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_API_TOKEN`、`NCF_BACKUP_ID`、`NCF_BACKUP_EPOCH`を保護された環境から渡し、IDや資格情報を追跡ファイルに書かない。targetの`BACKUP_OPERATOR_ENABLED` gateをstaging限定で有効化し、target app Workerを配備する。

```sh
node ops/staging/staging-config.mjs backup-operator-enable
pnpm exec wrangler deploy --config ops/staging/wrangler.staging.generated.jsonc
node ops/staging/backup-cron-config.mjs begin
pnpm exec wrangler deploy --dry-run --config ops/staging/backup-cron.generated.jsonc
pnpm exec wrangler deploy --config ops/staging/backup-cron.generated.jsonc
```

`backup_runs`の当該UUIDが`exporting`で、`control.backup_frozen=1`を確認した後、既存CLIで同じUUIDのSQL世代を抽出・検証・BACKUPSへ出版する。CLIの`capture`は凍結済み世代だけを受け付ける。`publish --remote`にはBACKUPS bucket限定のS3資格情報`R2_BACKUP_*`が必要である。`download`には`publish`結果のmanifest SHA-256を指定し、別のprivate領域に復元して検証する。元BLOBS byte検査は[隔離コピー手順](../../docs/BACKUP_BLOB_AUDIT.md)を参照。

```sh
pnpm backup capture --remote --config ops/staging/wrangler.staging.generated.jsonc \
  --database ncf-staging --id "$NCF_BACKUP_ID" --epoch "$NCF_BACKUP_EPOCH" --directory <private世代root>
pnpm backup publish --remote --directory <private世代root>/<UUID>
pnpm backup download --remote --id "$NCF_BACKUP_ID" --directory <別のprivate取得root> \
  --manifest-sha256 <検証済みpublication hash>
pnpm backup restore-offline --directory <取得root>/<UUID> --target <新しい隔離SQLite>
```

出版と隔離復元が成功した後、`NCF_BACKUP_MANIFEST_SHA256`に`publish`結果の検証済みpublication hashを渡して**同じUUID**の`complete`設定を生成し、同じ一時Workerを更新する。`complete`はR2のmanifest/partを検査し、最終的なD1 receiptと書込み解除をControlDOで確定する。`receipt`設定は状態確認専用で、必要なときだけ切り替える。最終確認には元D1の`backup_runs`を別途読み、`completed`、hash、解除時刻を照合する。

```sh
node ops/staging/backup-cron-config.mjs complete
pnpm exec wrangler deploy --config ops/staging/backup-cron.generated.jsonc
```

エラーや応答不明なら同じUUID・hashで状態を照合して再送する。別UUIDを作成したり、時限で解除したりしない。完了後は一時Workerを先に削除し、target gateを無効化して再配備する。削除に失敗した場合もgateを無効にしてRPC権限を閉じ、残ったWorkerの削除を続ける。

```sh
pnpm exec wrangler delete ncf-staging-backup-bridge --config ops/staging/backup-cron.generated.jsonc
node ops/staging/staging-config.mjs backup-operator-disable
pnpm exec wrangler deploy --config ops/staging/wrangler.staging.generated.jsonc
```

次の世代を始める際は、一時Workerを削除したことを確認してから、古い`backup-cron.generated.jsonc`を保護された端末で除去する。generatorは既存設定のUUIDを別UUIDへ変更しない。

定期運用では一時Workerを各世代の完了後に削除し、targetのprivate named entrypointのgateは次回実行用に有効のままにする。公開HTTP routeは追加しない。週次運用を停止する場合は、進行中の世代と凍結状態を確認したうえでtimer停止・bridge削除・gate無効化を行う。

このbridgeはD1、R2、Queue、HTTP経由の操作権限を持たず、任意SQLも実行しない。生成設定はgitignore対象の0600ファイルである。
