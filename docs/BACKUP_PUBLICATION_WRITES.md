# バックアップ保存の送信受付

更新: 2026-09-27。外部CLIのpart/manifest PUTに向けて、private `BackupOperator`に送信受付と終了記録を追加した。現在はサーバー側とbinding adapterまで実装済み。`publishGeneration`、S3/local store、`backup publish/run/daily`の実PUTへの接続は後続であり、既存CLI全体がこの記録で保護された状態ではない。

## 凍結中の記録

バックアップ抽出中はD1の通常68tableを凍結し、`r2_write_attempts`や`mutation_admissions`も変更できない。そのためControlDOのSQLite `control_backup_writes`へ保存し、D1の既存`backup_token`が世代全体の停止を保持する。D1 migrationは0046のまま。送信受付・終了記録の前後で全68tableが同一であることを試験している。

`grantPublicationWrite(epoch,id,request)`は次を要求する。

- 新しい試行UUIDと、凍結世代のid/epoch/token/createdAt/watermarkの完全一致。
- 同じ世代の正確なpart keyとSHA-256、または固定manifest key。partは最大8MiB、manifestは最大16MiB。
- ControlDOがfrozenで、D1も同じ世代・停止revision/token・drain状態を保持していること。D1読取り後にControlDOを再検査する。
- 完了検証のhashがまだ固定されておらず、未終了の保存試行がないこと。

許可を返す前にpendingを同期保存し、試行UUID・世代・epoch・終了用tokenを返す。同時pendingは1件だけ。応答を失った同UUIDにも許可を再発行しない。終了済みUUIDも同じ世代では再使用できない。receiptは世代当たり最大`2 * (BACKUP_MAX_PARTS + 1)`件で、次の世代の開始transaction内で終了済みreceiptだけを削除する。

`finishPublicationWrite(epoch,id,grant)`は元の試行・世代・epoch・barrier tokenと終了用tokenを照合し、pendingをendedへ変える。信頼されたexporterが実PUTの終了を証言する専用操作であり、object読戻し、timeout、プロセス終了だけで呼んではならない。同じ終了の再送は同じ世代中なら照合でき、別世代開始後の古い終了要求は拒否する。

## 完了・解除との競合

pendingが残る間は`complete`、`release`、`cancel`、同一/別世代の`begin`を拒否する。完了処理はD1読取り後にもpendingを検査してからhashを固定する。固定後は新しい送信受付を拒否し、解除intent保存後に届く古い受付も拒否する。

時間経過、正確なGET結果、DO evictionは終了証明にならない。grant応答喪失やnative結果不明では凍結を保持する。任意の解除・期限切れ回収RPCは提供しない。DO全storage喪失時にもD1の既存凍結を自動解除しない。

2操作は既存[BackupOperatorの専用capability](BACKUP_OPERATOR.md)でのみ公開し、一般HTTP APIは追加しない。private bindingドリルでは環境不一致・capabilityなし・無効化された接続からの両操作を拒否する。

## 次の接続

1. CLIの各PUT前に新しい要求でgrantを取得し、一度だけnative呼出しを実行する。grant不明時の再送を行わない。
2. S3/local storeの元のnative Promiseの終了を記録する。timeout後の実成功も終了だけを記録し、期限切れのpublicationを再開しない。
3. object読戻しによる保存確認とnative終了記録を分離する。例外後にobjectが一致してもpendingを解消しない。
4. 独立した`publish`も同じ受付へ接続し、operator設定のない無記録PUTを残さない。既に送信された旧CLI処理の記録は後付けできず、実配備時の旧処理終了確認は別途必要。

検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、他の14種類の記録と残る復旧境界は[R2_WRITE_SETTLEMENT](R2_WRITE_SETTLEMENT.md)を参照。
