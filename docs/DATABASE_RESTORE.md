# D1復旧要求の準備と停止保持

更新: 2026-09-27。Time Travel / logical exportからの稼働系復旧に向けた、準備段階・logical世代照合・信頼されたSQL検証者による証言を実装した。[運用CLI](DATABASE_RESTORE_OPERATOR.md)で準備・検証・照会・取消しを行える。D1の上書きと新epochへの採用はまだ接続していない。`preparing`や`sql_verified`を上書き許可やR2処理の全終了証明として扱わない。

## 内部RPC

| RPC | 動作 |
|---|---|
| `prepareDatabaseRestore(epoch, id, source)` | 現行epochのDO内に要求を保存し、通常受付を閉じてD1をquiesceする |
| `inspectDatabaseRestore(epoch, id)` | D1へアクセスせず保存済み要求を照会する |
| `verifyDatabaseRestoreSource(epoch, id)` | logicalの完了記録・manifest・SQL部品を少量ずつ照合し、検証位置を保存する。[詳細](DATABASE_RESTORE_SOURCE.md) |
| `attestDatabaseRestoreSql(epoch, id, hash)` | 信頼された検証者による全SQL/schema検証の証言を、準備中の同じ世代に結び付けてDOへ保存する |
| `cancelDatabaseRestore(epoch, id)` | 正確な要求を取り消す。準備中は再度quiesce、凍結中は原子的な解除と停止token更新を使い、受付とGCの停止を維持する |
| `freezeDatabaseRestore(epoch, id, targets, input?)` | 現行binding照合を使ってD1全通常tableと新規repair受付を凍結する。再送は同じ対象と保存済みtokenを確認。[詳細](DATABASE_RESTORE_FREEZE.md) |

いずれもsingletonの内部RPCで、専用DatabaseRestoreOperatorのservice bindingへ接続する。HTTP endpoint、既存BackupOperatorの権限追加、remote設定はない。

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

`preparing`中のsystem/global受付とrepairは、D1の閉じたmirrorが一致する場合に継続できる。`freezing`/`frozen`/`cancelling`へ進んだ要求ではこれらも拒否する。未知KDF receipt、upload予約、multipartの保留を準備要求だけで解放しない。既存backupの永続barrierがあれば、復旧要求を作る前に拒否する。

primary照会中に始まった復旧要求は、遅延したopen status、バックアップ開始、epoch予約にも適用する。古い再開batchはquiesceのrevision/tokenで拒否する。取消しの照会中に別の取消し・全監査・再開が完了した場合、遅い取消しは履歴だけを返し、再開後の状態を再停止しない。

DOで閉鎖完了が確定している場合、次のquiesceはD1の同じepoch/revision/tokenと停止policyを先に照合する。epochが同じでも、停止前のD1 snapshotへ戻っていれば準備の再送・取消し・repairで上書きせず、holdを維持する。閉鎖そのものがまだ未確定の場合は既存の永続closing intentで再試行する。この段階では外部restoreを開始できない。

取消し時は既存監査を無効化する。凍結intentがあれば[凍結取消し](DATABASE_RESTORE_FREEZE.md)の原子的な解除と停止token更新を使う。再開する場合は、[CONTROL_ADMISSION](CONTROL_ADMISSION.md)の全監査→受付再開→GC再開を改めて行う。D1のepochが異なる、primary不明、backup状態不明のままholdだけを消す操作は用意しない。

## 次の接続と未検証範囲

稼働系復旧の完成には以下が必要で、今回の準備RPCは代替しない。

1. 信頼できる世代・bookmark・対象bindingの検証。logicalの完了記録・R2部品照合と、CLIによる保存時schema/全table/hash/FKの再検証・DOへの証言は接続済み。D1対象、Time Travel bookmarkの時刻検索、BLOBSのfresh probe照合も接続済み（[対象](DATABASE_RESTORE_TARGET.md)・[bookmark](DATABASE_RESTORE_BOOKMARK.md)・[BLOBS](DATABASE_RESTORE_BLOBS.md)）。BACKUPSと同じ停止状態での[BLOBS/BACKUPS一括照合](DATABASE_RESTORE_BINDINGS.md)も接続済み。最終停止とremote検証を続ける。
2. R2 delete・upload・multipart・KDF・job・repairの終了証明を集める。D1書込みと新規repair受付の永続的な凍結に加え、[空ファイルPUT・配信manifestの保存/削除](R2_WRITE_SETTLEMENT.md)の永続記録を接続済み。既存upload/GC/multipart・probe・BACKUPS・epoch履歴を含む全操作の終了条件と未知結果の収束は未統合。
3. D1上書き前に新epochをDO/R2履歴へ予約する。応答不明時に重複発行・再使用しない。
4. 外部のTime Travelまたはlogical importを実行し、選択した状態と実際の復元先を照合する。
5. 復元されたbackup freeze/tokenを正確な要求に結び付けて解消し、新epochをD1へ採用する。snapshotのcommitted/failed operationは保持する。
6. FTS再構築、D1/R2の全監査、段階再開、再開後CRUD、実Cloudflareでの復旧ドリル。

現時点のテストは停止保持・競合・取消し・R2世代照合のローカルDO/D1/R2試験。control行だけを戻す試験を実Time Travel成功と呼ばない。ControlDO自体の全storage喪失、別account、D1の全schema喪失からの要求復元も未実装。準備要求があるだけではD1の手動上書きを開始しない。

### 最終停止へ接続する際のコード上の境界

以下は最終停止全体の接続条件であり、`verify-bindings`の保証には含めない。D1書込み凍結は[専用工程](DATABASE_RESTORE_FREEZE.md)へ接続済み。

- `ControlAdmission.captureSystemMutationMode/systemMutationMode/assertSystemMutationMode`は受付前・D1待機後の両方で凍結intentを検査する。共通mutationのD1述語はepoch/maintenanceであり、停止revision/tokenを変えるだけでは送信済みの同epoch・closed mode更新を拒否できないため、migration0040の全通常table triggerでD1確定点を保護する。
- `control_maintenance_tasks`と`KdfSettlements.assertEmpty()`はDO外部に出た処理の保留を保持する。再起動・lease期限・時計経過だけで空にしない。KDFの実終了記録がD1へ精算済みであることと、R2/delete/upload/multipart各台帳の終了条件を最終停止の前に確認する。
- `ControlR2Writes.assertEmpty()`とD1の`r2_write_attempts`は空ファイルPUT・manifest PUT/DELETEの保留を保持する。DO全喪失後もD1 pendingが再開・凍結を拒否する。既知終了のrepairはあるが、unknownをHEADや時計から解消しない。
- `recoveryAudit.ts`の`RECOVERY_FINAL_QUERY`はサービス再開用のfenceで、予約・upload・GC・job・outbox・inventory/probe・multipart・bootstrapの条件を含む。復元直前の終了証明に使う場合は各条件の意味を確認し、DOの保留や送信済み外部操作の証明を併せる。`ControlBackup`のfreeze条件だけではこの確認を満たさない。
- `ControlDO.#reserve/#completePending`は通常のepoch発行とD1への即時採用を組み合わせている。復旧では、要求IDに固定した新epochをDO/R2へ先に予約し、外部D1復元後の採用とは分ける。準備取消しや通常recover経由で予約を捨てたり、復元前に採用したりしない。

最低限の競合試験は、最終停止中の新規repair・待機中の受付・遅延D1 batch・未知R2/KDF・停止ACK喪失・DO eviction・取消し・同一要求再送である。復元後のsnapshot照合、terminal operation保持、全監査、受付/GCの段階再開はその後に接続する。
