# 期限切れバックアップの回収

更新: 2026-09-25。`pnpm backup prune`は、明示した1世代の期限切れSQLバックアップを、対象Workerの`BACKUPS` bindingから少量ずつ削除する。元の`BLOBS`、ローカル保存先、D1の完了記録は変更しない。

```sh
pnpm backup prune --local \
  --operator-config scripts/backup/operator.local.example.json \
  --epoch <現在のControlDOのepoch> --id <期限切れ世代のUUID>
```

remoteは`--local`を`--remote`へ変更し、[専用bindingのdescriptor](BACKUP_OPERATOR.md)を使う。このコマンドは`--config/--database/--directory`やR2用S3資格情報を受け取らない。削除先は対象Worker自身のBACKUPSに固定される。epoch引数は現在のControlDOの値であり、回収する世代が古いepochでもよい。公開HTTP routeは追加していない。

## 回収対象

- primary D1に不変の`completed` receiptがあり、manifest key/hash・世代・解除/完了時刻が有効であること。
- サーバーが保存した`created_at`から、現在のサーバー時刻までが**35日を厳密に超える**こと。ちょうど35日は削除しない。完了時刻やrunnerの時計では期限を延長しない。
- R2 manifestの実SHA-256が完了記録と一致し、ID・元epoch・開始token・作成時刻・watermarkも一致すること。
- ControlDOとD1のepochが一致し、バックアップの開始・凍結・解除処理が実行中でないこと。

最少5世代に足りない場合も35日超の世代を有効世代へ戻さない。世代数の不足は[health](BACKUP_RETENTION.md)、新しい世代の補充は[maintain](BACKUP_MAINTENANCE.md)で扱う。prune自体は世代補充を行わない。

pending/exporting/failed、記録が失われた世代、manifestが破損した世代は自動回収しない。将来の全世代走査、未完了・未追跡objectの回収は別工程である。

## 少量ずつの削除と再開

1 RPCは、世代の正確なprefixを最大21件一覧し、manifestに記載された部品を最大20件削除する。part index/hashから再構成したkeyだけを受け付け、同じprefix内に未知のkeyがあれば、そのページの削除を拒否する。大きなSQL本文は読み込まない。manifestは最大16MiBで読む。

削除前にはprimary D1の完了記録、期限、epochとバックアップ状態を再確認する。R2処理は各10秒の待機上限を持ち、RPC開始から固定25秒を超えた後は次の外部要求を送らない。同じControlDO instanceでは同時に1件だけ実行する。期限を超えて既に送信済みのDELETEが完了する可能性はあるが、その後のmanifest削除や成功判定へ進まない。

部品を削除した後、世代prefixにmanifest以外のobjectが残っていれば`pending`を返す。残りがなくなってからmanifestを最後に削除し、prefix全体の不在を再確認して`absent`を返す。R2の[強い整合性](https://developers.cloudflare.com/r2/reference/consistency/)と、bindingの[LIST/DELETE仕様](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)を前提とする。1ページの件数だけでは全件取得と判断せず、`truncated`も確認する。

途中停止・応答喪失後は同じUUIDと現在のepochで再実行する。残っているR2 keyを再取得するため、進捗cursorや回収完了のDOローカル台帳を必要としない。最後のDELETEの応答を失い、manifestが既になくても、完了記録と期限を再確認したうえでprefix全体が空なら`absent`へ収束する。manifestがないのに他のobjectが残る場合は削除対象を推測せず停止する。

完了済みD1 receiptは保持する。別の管理者や手動publishが期限切れUUIDへ再アップロードすることを禁止するtombstoneではなく、`absent`は検査時点の不在を示す。稼働中バックアップのUUIDを再利用しない既存の契約を維持する。D1の復元・全喪失や外部管理者の書換えを同時に行う運用は、この回収の成功だけで安全性を証明できない。

## 終了コードと運用範囲

CLIは最大100 RPC、通常最大2,000部品を処理する。最後のJSONは`command:prune`と`result`を持つ。

| 終了コード | 結果 |
|---|---|
| 0 | `complete:true/state:absent`。対象prefixの不在を確認済み |
| 2 | `complete:false/state:pending`。回数上限に到達したため同じコマンドで続行する |
| 1 | 権限・期限・世代照合・接続などで失敗。原因を確認して同じ世代から再実行する |

各`backup_prune`イベントの`deletedObjects`は、そのRPCでDELETEの応答を確認したkey数であり、生涯の一意な削除数ではない。応答喪失時に成功数を推測しない。秘密情報、SQL本文、providerのURLはログに出さない。

maintainとLinux timerからの自動削除はまだ接続していない。運用者がhealthの`expired`世代などを確認し、UUIDを指定して実行する。remote実行、定時走査の設置、外部通知、D1/全storage喪失後の世代選択、Time Travelとlive復旧は未検証・未完了である。

## 検証

NodeでCLI継続回数、応答形式、同じ世代への継続、失敗時の打切りとエラー非公開を検証する。workerdの実D1/R2/ControlDOで、35日の境界、旧epoch、20部品上限、eviction、完了記録保持、manifest/key不一致、応答喪失、期限切れ後の遅延DELETE、途中のbarrier/epoch/receipt変更を検証する。

専用bindingドリルと実CLIドリルは、隔離した期限切れtransport fixtureの削除・再送、実SQLの新しい世代の削除拒否を検証する。期限切れfixtureは復元可能なSQL世代として扱わない。実行結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。
