# D1復旧要求の準備と停止保持

更新: 2026-09-25。Time Travel / logical exportからの稼働系復旧に向けた、ControlDO内部の準備段階とlogical世代の照合を実装した。D1の上書き、新epochへの採用、運用者用CLIはまだ接続していない。`preparing`を上書き許可やR2処理の全終了証明として扱わない。

## 内部RPC

| RPC | 動作 |
|---|---|
| `prepareDatabaseRestore(epoch, id, source)` | 現行epochのDO内に要求を保存し、通常受付を閉じてD1をquiesceする |
| `inspectDatabaseRestore(epoch, id)` | D1へアクセスせず保存済み要求を照会する |
| `verifyDatabaseRestoreSource(epoch, id)` | logicalの完了記録・manifest・SQL部品を少量ずつ照合し、検証位置を保存する。[詳細](DATABASE_RESTORE_SOURCE.md) |
| `cancelDatabaseRestore(epoch, id)` | 正確な要求の準備だけを取り消す。D1を再度quiesceし、受付とGCは停止を維持する |

いずれもsingletonの内部RPCである。HTTP endpoint、既存BackupOperatorの権限追加、remote設定はない。

`id`は運用者が一度生成して再送するUUID。`source`は次のいずれかを正規化して保存する。

```ts
{ kind: "logical", id: generationId, epoch: generationEpoch, manifestSha256 }
{ kind: "time_travel", bookmark }
```

logicalのhashは64桁の小文字hex、bookmarkは1〜256文字の空白・制御文字なしASCII。ここではbookmarkを不透明な選択値として保持するだけで、Cloudflare上の存在・対象DB・時点を検証しない。logicalの指定もSQL・manifestの検証済み証言ではない。

`manifestSha256`は公開されたR2 publication manifestのhashを指し、既存の完了receiptと同じ意味である。世代IDは既存のbackup出版形式と同じUUID形式を受け付ける。

同じid・epoch・選択値は同じ作成時刻で再照会できる。内容を変えた同じid、別epoch、別の同時要求は拒否する。取消し済み要求は履歴として残し、遅延した再送で新たな停止を開始しない。

## D1障害と競合

ControlDOのSQLite `control_database_restore`に要求を書いてからD1へアクセスする。D1停止の開始に失敗しても要求を自動削除しない。DOの`status()`はmaintenance/GC pauseを返し、DO再起動後も同じ停止を保持する。D1のepochを過去へ戻してもこの記録は巻き戻らない。

準備中は以下を拒否する。

- 通常mutation、bootstrap mutation、KDFの新規dispatchと、open modeの内部mutation。
- 受付再開、GC policy変更、通常稼働中のtrash restore pauseの開始/解除。
- 通常のepoch発行、バックアップの開始・日次計画・完了・解除・取消し・inventory・回収。

停止中のsystem/global受付とrepairは、D1の閉じたmirrorが一致する場合に継続できる。未知KDF receipt、upload予約、multipartの保留を準備要求だけで解放しない。既存backupの永続barrierがあれば、復旧要求を作る前に拒否する。

primary照会中に始まった復旧要求は、遅延したopen status、バックアップ開始、epoch予約にも適用する。古い再開batchはquiesceのrevision/tokenで拒否する。取消しの照会中に別の取消し・全監査・再開が完了した場合、遅い取消しは履歴だけを返し、再開後の状態を再停止しない。

DOで閉鎖完了が確定している場合、次のquiesceはD1の同じepoch/revision/tokenと停止policyを先に照合する。epochが同じでも、停止前のD1 snapshotへ戻っていれば準備の再送・取消し・repairで上書きせず、holdを維持する。閉鎖そのものがまだ未確定の場合は既存の永続closing intentで再試行する。この段階では外部restoreを開始できない。

取消し時のquiesceは既存監査を無効化する。再開する場合は、[CONTROL_ADMISSION](CONTROL_ADMISSION.md)の全監査→受付再開→GC再開を改めて行う。D1のepochが異なる、primary不明、backup状態不明のままholdだけを消す操作は用意しない。

## 次の接続と未検証範囲

稼働系復旧の完成には以下が必要で、今回の準備RPCは代替しない。

1. 信頼できる世代・bookmark・対象bindingの検証。logicalの完了記録とR2部品照合は接続済み。保存時schema/全table/hash/FKの再検証と運用経路への接続を続ける。
2. R2 delete・upload・multipart・KDF・job・repairの終了証明を集め、停止中repairも禁止する永続的な最終段階へ移す。
3. D1上書き前に新epochをDO/R2履歴へ予約する。応答不明時に重複発行・再使用しない。
4. 外部のTime Travelまたはlogical importを実行し、選択した状態と実際の復元先を照合する。
5. 復元されたbackup freeze/tokenを正確な要求に結び付けて解消し、新epochをD1へ採用する。snapshotのcommitted/failed operationは保持する。
6. FTS再構築、D1/R2の全監査、段階再開、再開後CRUD、実Cloudflareでの復旧ドリル。

現時点のテストは停止保持・競合・取消し・R2世代照合のローカルDO/D1/R2試験。control行だけを戻す試験を実Time Travel成功と呼ばない。ControlDO自体の全storage喪失、別account、D1の全schema喪失からの要求復元も未実装。準備要求があるだけではD1の手動上書きを開始しない。
