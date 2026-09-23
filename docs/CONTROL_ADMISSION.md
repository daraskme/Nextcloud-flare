# ControlDOの停止・監査・再開

`ControlDO`のsingletonが受付状態の正本で、D1 `control`はSQL mutation用のmirrorである。migration `0025`で`admission_revision`と`admission_token`を追加した。通常tableは61のまま。以下はWorker内部のoperator RPCであり、公開HTTP endpointは追加していない。

## 順序

1. `recover()`でepochを回復する。初回・DO保存領域喪失時はR2 epoch履歴/D1/operator floorより新しいepochを発行し、maintenanceとGC pauseを設定する。
2. `quiesce(epoch)`で新規受付を止め、D1のopen permitをrevoke、claimed operationをfailedへ収束する。返値の`activeJobLease`がtrueなら進行中処理が残る。
3. upload、GC、outbox、inventory、FTSの必要な停止中repairを行う。未知multipartの予約保持や未解決scanを飛ばさない。
4. `beginRecoveryAudit(epoch)`、続いて`nextRecoveryAuditPage(epoch, limit)`を`completed=true`まで実行する。全pageの証明は同じepoch/audit tokenに属する。
5. `resumeAdmission(epoch)`で受付を再開する。GC pauseは維持する。
6. `resumeGarbageCollection(epoch)`でGCを最後に再開する。`pauseGarbageCollection(epoch)`は受付を維持したGC停止に使える。

停止・epoch更新・repairは過去の監査を無効化する。`resumeAdmission`の再送は既にactiveなら現在状態を返し、GC設定を勝手に変更しない。GC操作は受付再開前には実行できない。通常稼働中のごみ箱復元は[RESTORE_GC](RESTORE_GC.md)の期限付きholdを使う。migration `0026`で管理者の停止設定を分離し、hold中は明示的なGC再開も拒否する。監査pageはactive/opening中に進められない。

初回の完全に空のDBは監査可能である。再開後のbootstrapは既存のAccess JWT・owner allowlist・原子的bootstrapを通る。部分的なbootstrap、既存user/spaceだけがあるDB、bootstrap identityと有効adminの不一致は拒否する。実際にuser・root・blob・physical ledgerのあるDBでも全監査から再開まで検証している。

## 遅延処理と応答喪失

DO SQLiteの`control_admission`にepoch/revision/token、遷移中phase、直前token、GC目標値、監査tokenを保存してからD1へアクセスする。D1/R2を待っている間の`status()`は受付停止を返す。open状態でもD1の同じepoch/revision/token/flags・管理者GC設定・restore holdを確認し、その応答後にDOの状態を再確認する。

再開は直前のrevision/tokenと停止flagsに対するCASである。全予約、upload cleanup、GC、job lease、旧epoch outbox、inventory/probe、bootstrap、permit/claimの最終条件を同じD1 batch内でassertしてから開く。事前のSELECTだけでは開かない。停止は新しいrevisionを発行し、それ以前の遅延open/GC変更を拒否する。遅延した古いstopも、新しく再開した状態とpermitを上書きできない。

batchの応答が失われた場合、同じtransitionのD1結果を読み直す。readbackも失敗すると遷移intentを残して受付停止を維持する。eviction後も同じRPC/expected epochで再送できる。新しい停止・epochが先に進んだ場合は競合として拒否する。D1へflagsを直接書いて復旧しない。

epoch publicationもrevision=0の初期状態に限定し、遅れて届いた同一epochの回復処理がactive状態を再び閉じたり、permitをrevokeしたりしない。新epochとDOの停止状態は同じローカルtransactionで公開する。

## 修復処理との排他

停止中repair RPCはDO SQLite `control_maintenance_tasks`に処理tokenを保存し、処理前後に監査を初期化する。処理途中に別の呼出しが監査を進めても、処理tokenが残る間は再開できない。正常終了・例外終了ではfinallyでtokenを削除する。

isolateが失われ、finallyが実行されなかった処理tokenは期限だけでは消さない。新epochを発行した上でD1/R2の未完了処理を収束し、新しい全監査を行う。旧epochのtask tokenを消すこと自体はR2処理の完了証明ではなく、upload/GC/inventoryの既存fenceとdrainが引き続き必要である。

ローカルintentの保存には同期SQLと`transactionSync`を使い、外部I/Oをinput gateで囲まない。cursorはawait前に消費する。[CloudflareのSQLite storage仕様](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)に従う。

## 検証と未完了範囲

- real ControlDO/LockDO/D1/R2で全監査→受付再開→folder mutation→停止を検証。
- Worker entryからAccess JWT/JWKS、allowlist bootstrap、`/me`、停止503・無認証401・対象外403を検証。
- open/stop/GC pause/resumeのcommit前後の応答喪失、readback障害、eviction、同時再開、遅延dispatch/ack、状態照会と停止の競合を検証。
- 監査完了後の予約・permit・bootstrap変化、進行中/中断repair、epoch更新、DO全喪失、遅延したepoch publicationを検証。
- 実Cloudflareへの配備・実サービス受付再開・完全restore drillは未実施。account単位のmutation同時数/待ちqueue、KDF admission、backup専用barrier、operator HTTP/管理UIは別の未実装範囲。

未知multipart全体閉鎖・予約精算、他prefixのinventory、残るQueue event修復はこの変更で解決したと扱わない。各未解決状態は引き続き再開gateを閉じる。
