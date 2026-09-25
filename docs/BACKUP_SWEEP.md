# 期限切れバックアップの自動走査

更新: 2026-09-25。`pnpm backup sweep`はD1の完了記録を走査し、35日を厳密に超えたSQL世代を[prune](BACKUP_PRUNING.md)と同じ検証・削除経路で回収する。走査位置はControlDOのSQLiteへ保存する。CLIの再実行やDOのeviction後も未完了の走査を継続する。

```sh
pnpm backup sweep --local \
  --operator-config scripts/backup/operator.local.example.json \
  --epoch <現在のControlDOのepoch>
```

remoteでは`--local`を`--remote`へ変更し、[専用bindingのdescriptor](BACKUP_OPERATOR.md)を指定する。対象WorkerのBACKUPSを使うため、UUID・D1の任意SQL設定・R2のS3資格情報は受け取らない。単独のsweepは健全世代数の検査や補充を行わない。日次運用では`maintain --prune-expired`を使う。

## 永続化する走査範囲

計画時にround UUID、サーバー開始時刻、D1の最大IDを保存する。世代年齢はこの開始時刻で判定し、走査中に35日を超えた世代は次のroundへ回す。最大IDを越える世代も次回へ回す。これはD1全体のsnapshotではない。途中で追加された小さいIDの観測はcursorの位置に依存するため、復元・外部書換えを並行する運用の安全性を証明しない。

1 stepは主キー順で最大100行を読み、期限切れcompleted世代を最大1件処理する。1世代の削除は最大20部品で、manifestは他のobjectがなくなってから最後に削除する。大きな世代では同じ候補を次のstepでも処理する。既にprefixが空の世代も検証してcursorを進めるため、保持している古いreceiptだけで後続の回収が永久に止まることはない。

CLIは計画照会1回と最大100 stepで終了する。未完了なら次の実行も同じroundを継続する。完了済みroundを指定したRPC再送は同じ結果を返し、次の計画照会で新しいroundを開始する。current epochが変わった場合は新しい計画が必要であり、旧epoch・旧roundのstepは拒否する。

D1 receipt、元BLOBS、ローカル世代は削除しない。DOの走査台帳を喪失した場合は先頭から再走査するが、R2の残存keyとD1 receiptから再判定できる。削除済みUUIDへの手動再公開を禁止するtombstoneではない。

## 異常時と再開

manifest hash・世代不一致、既知形式の破損、未知key、manifest欠落時の部品残存、不正receiptなど、限定した検証エラーはその世代を保留して後続へ進む。round内の累計`errors`と最後の`lastError:{id,code}`を保存し、eviction後やCLIの次回実行でも警告を維持する。全エラー履歴の永続保管ではないため、詳細な監査には各`backup_sweep`進捗JSONを保存する。

未知の接続失敗、応答不明、timeout、epoch・バックアップ状態の変化ではcursorを進めず失敗する。同じコマンドを再実行して実際のR2状態を照合する。読取り不能など、破損と一時障害を区別できないエラーもここに含む。未完了・failed世代や記録のないobjectはこの走査で回収しない。

manual pruneと同じControlDO instance内で排他し、開始・凍結・解除中のバックアップと競合する場合は拒否する。D1 mirrorとDO権威を照合し、R2要求ごとの10秒待機上限と、D1走査待ちを含むstep開始から固定25秒の開始期限を維持する。送信済みDELETEの取消しを保証するものではない。

最後のJSONは`command:sweep`と`result`を持つ。`round/state/startedAt/after/through/scanned/absent/errors/lastError/steps/complete/healthy`が進捗を示す。`scanned`はcursorを進めたreceipt数、`absent`は不在確認済み世代数であり、今回新たに削除した世代数ではない。

| 終了コード | 意味 |
|---|---|
| 0 | round完了、保留した検証エラーなし |
| 2 | 100 stepの上限で未完了、またはround内に破損等の保留あり |
| 1 | 権限・接続・epoch等で失敗。原因を確認して再実行する |

## 日次運用への接続

`maintain --prune-expired`は、日次取得・不足/鮮度補充を終え、最終healthが検査完了・正常・active backupなしの場合だけsweepを実行する。省略時は削除しない。結果の`health`と`cleanup`を分けて返し、回収が未完了または警告ありなら全体を終了コード2にする。取得が正常だったことを、回収の警告で失わない。接続失敗などの例外は終了コード1であり、それ以前の進捗JSONで取得結果を確認する。

[Linux service例](../ops/backup/nextcloud-flare-backup.service)はこのoptionを指定する。timerの設置・起動、外部通知先の接続、remote実行は行っていない。大きいroundは複数回の定期実行を必要とする。運用手順は[BACKUP_MAINTENANCE](BACKUP_MAINTENANCE.md)。Time Travel、live復旧、新epochと全監査、全storage喪失後の世代選択は別工程である。

## 検証

Nodeで100 step上限・再開、応答検査、警告の維持、maintainの実行条件と終了判定を検証する。workerdでは実D1/R2/DOによる205行の分割走査、100件の不在receipt後の回収、途中削除・応答喪失・eviction、固定期限とID上限、破損保留、epoch/backup競合、manual pruneとの排他を検証する。

専用bindingドリルは9操作の権限拒否、健全な5世代を保持した期限切れfixture回収、破損警告とhealthの分離を確認する。実CLIドリルはsweepとmaintainのoptionを通して回収・再送・receipt保持を確認する。期限切れfixtureはtransport検証専用で、復元可能なSQL世代とは扱わない。結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。
