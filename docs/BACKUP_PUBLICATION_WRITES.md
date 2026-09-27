# バックアップ保存の送信受付

更新: 2026-09-28。外部CLIのpart/manifest PUTを、private `BackupOperator`の送信受付・終了記録へ接続した。`publishGeneration`からS3/local storeの元のnative応答を追跡し、`backup publish/run/daily/maintain`が同じ経路を使う。単独publishにも`--operator-config`を必須とする。

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

送信前後の`checkPublicationWrites(epoch,id,generation)`も同じ世代の全tupleとpending不在を確認する。全objectが既に読めてPUTを省略する再実行でも、この確認を省略しない。検証中・解除中・解除済みの同じ世代は読取り照合できるが、後継世代が始まった後は古い確認を拒否する。3操作は既存[BackupOperatorの専用capability](BACKUP_OPERATOR.md)でのみ公開し、一般HTTP APIは追加しない。

## CLIのnative終了

1. CLIはSQL検証後に未終了試行がないことを照会する。各PUT前に新しい要求でgrantを取得し、全応答項目を検証してから一度だけnative処理を呼ぶ。grant RPCのtimeout後に応答が届いても送信しない。
2. S3はredirectでないHTTP 200/412、local R2はPUT Promiseの成功（条件不成立のnullを含む）だけから終了callbackを呼ぶ。終了RPCの確認後にPUTを返し、従来のGET・checksum・SQL全体hash検証へ進む。storeがcallbackなしで成功を返しても採用しない。
3. 通信例外・HTTPエラー・timeoutは結果不明として停止する。objectの一致では解消しない。元のnative応答が遅れて戻った場合、生きている継続は終了記録だけを送り、期限切れのpublicationを再開しない。終了RPCの応答を失った場合も、その呼出しは失敗し、次の実行でサーバー状態を照合する。
4. grant/check/finishのprivate RPCは既存adapterで各最大60秒、native I/Oは既定60秒。native待機中にCLIを終了してもpendingは残る。ControlDOを終了したり通信を失ったりして終了事実が記録できなければ、再起動しただけでは送信・解除を再開できない。

native結果が不明な試行を外部証明から安全に解除する運用経路は未実装。既に送信された旧CLI処理の記録は後付けできず、実配備時の旧処理終了確認も別途必要。epoch履歴・新epoch予約・live採用は引き続き後続である。

検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、他の14種類の記録と残る復旧境界は[R2_WRITE_SETTLEMENT](R2_WRITE_SETTLEMENT.md)を参照。
