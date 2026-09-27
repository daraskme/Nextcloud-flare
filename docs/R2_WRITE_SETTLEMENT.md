# ファイル保存・multipart・配信manifest・GCのR2書込み記録

更新: 2026-09-27。migration `0041`〜`0046`、通常68table。期限切れBACKUPS世代のDELETE・BLOBS/BACKUPS接続probe・空ファイルPUT・単一/DAV PUT・multipart作成/part/完了/中止・target manifest PUT/DELETE・blob/orphan GCのDELETEを送信前から記録し、結果不明のまま復旧凍結・受付再開・対象GCへ進むことを防ぐ。

## 接続した送信点

| 操作 | 送信条件 | 完了の扱い |
|---|---|---|
| BACKUPS世代削除 | 完成receiptの全tuple/hash、35日超の保持、元epoch・停止mode/revision/token、世代内の正確な1〜20 key。同じ世代のpendingなしをgrant batchで再検査し、DO側の元のbackup/停止状態も確認 | `backup.delete`の実成功を記録してから次の一覧へ進む。part batchと最後のmanifestを別試行にし、応答喪失では追加削除・absent確定を保留する |
| BACKUPS接続probe | 固定key `sys/restore/binding-probe-v1`、明示null owner、元の復旧要求/試行/nonce/bucket/期待ETagと停止challenge。DO原本をgrant前後と送信直前、D1停止revision/tokenをgrant batchで再検査 | `backups.probe.put`のnative実終了を記録してからchallengeを返す。条件不成立のnullも終了記録へ反映するが、接続確認はconflictで失敗する |
| BLOBS/S3接続probe | 固定system key、明示null owner、元のlease token/nonce/source/期待ETag、prepared phase、現epoch・maintenance/GC停止をgrant batchで再検査。復旧先照合では停止revision/tokenと元期限も要求 | `probe.put`のnative実成功を記録後にS3読戻しへ進む。条件不成立のnullもnativeが終了した事実として記録するが、接続検証はconflictで失敗する |
| `createLockedEmptyFile` | 元のLockDO permit・認可に加え、実ownerの共通受付と永続grant。既存keyを上書きしない条件付きPUT | native PUT成功だけを終了記録へ送る。条件不成立の`null`は終了したno-opで、既存の空objectをHEADで検証する |
| `stageTargetManifest` | 新しいUUID key・実owner・現epochで共通受付と永続grant。保持中の履歴と同じkeyを使うPUTは拒否 | 条件付きPUTの終了を記録後、従来のmanifest読戻し・hash検証・ticket公開へ進む |
| `discardUnpublishedManifest` | 従来の公開取消しbatchの直接ACKを維持。成功したstagingのowner/key、未公開、同keyのpendingなしをD1で再検査 | 専用global受付でDELETEを記録する。安定したmaintenance中も回収できるが、復旧凍結中は新規受付しない |
| blob GC（通常・停止中・ゴミ箱復元中） | 元のGC予算ACK後、実owner/key/blob ID、claim token/epoch/lease、ref/pin、未精算upload、現在の停止modeをgrant batchで再検査。復元中は元のoperation/token/期限も要求 | `blob.delete`を記録し、実際のDELETE成功と終了記録の反映後に確認HEADと容量精算へ進む |
| orphan GC（通常・停止中） | 明示null owner、35日猶予、解釈可能なowner key、旧epochまたは現epoch、claim token/lease、全object tupleとcatalogueからの独立を再検査 | `orphan.delete`を記録。owner未復元やUnicode keyも扱い、結果不明のDELETEをHEADで解消しない |
| 単一upload / DAV PUT | 元のupload ID、write attempt、転送lease、現credentialとnode認可、予約、staging blobをgrant batchで再検査 | `upload.put`のnative終了後にstream/hash検証と公開へ進む。DAVの公開permitは本文転送後に取得する |
| multipart create / part / complete | 元のupload、attempt、lease、R2 upload ID、part番号、D1 part mirrorとcomplete時の全part証明を再検査 | `multipart.create` / `multipart.part` / `multipart.complete`を記録。観測済み完成objectは過去のnative終了証明に使わない |
| multipart中止 | 初期化ID保存失敗時、既知ID cleanup、未知ID inventory、全bucket中止を元のclaim/attempt/handleへ束縛。inventoryは有効なbinding proofとscan、全bucketはpart/scan roundと元の中止receiptも再検査 | `multipart.abort` / `bucket.abort`を記録。後者のownerは明示null。handle閉鎖と各native呼出しの終了を別々に保持する |

条件付きPUTの不成立は`null`を返すという[R2 Workers APIの契約](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)を利用する。例外になったPUTの後にobjectが見えても、その呼出しが終了した証明には使わない。

## 送信前と終了後の順序

1. Workerが新しい要求UUIDと最大5秒の開始期限を作る。GCでは呼出し元の固定期限と復元pauseの期限も上限にする。ControlDOはowner・kind・key・epoch・GC証明を検証し、token付きの`pending`を自身のSQLiteへ同期保存する。
2. 通常操作と同じ共通mutation枠でD1の`r2_write_attempts`へ正確な試行を記録する。D1 batchの直接ACK、現行受付、期限を再確認してからgrantを一度だけ返す。読み戻したreceiptから送信許可を再発行しない。
3. Workerはgrantの全フィールドと期限を確認して、一度だけnative R2処理を呼ぶ。戻る前に期限切れとなったgrantは`not_started`。grant応答自体を失った場合は送信せず、記録を残す。
4. native Promiseが成功した場合だけ`finishR2Write(..., "succeeded")`を呼ぶ。ControlDOに終了事実を先に保存し、共通global受付でD1へ反映する。正確なD1終端行を照合後、DOのreceipt削除と使用済みID保存を一つのtransactionで確定する。

beginのD1更新が失敗し、grantを一度も返していない場合は`not_started`を永続化する。D1の終端行は遅延した同IDのINSERTを主キーで拒否する。開始batchのACK喪失を再送許可へ変えない。

DOの未精算receipt・D1のpendingはそれぞれ全14種類で共有する最大32件。空ファイルの同keyへの並行条件付きPUTは個別の試行として数える。開始・終了のD1処理には既存の32 active/256 waiting枠を使い、R2待機中はその短期枠を保持しない。BLOBS probeの開始は`global:r2.probe-put`、BACKUPS probeは`global:r2.backups-probe-put`、世代削除は`global:r2.backups-delete`、GCは`global:r2.gc-delete`、multipart中止は`global:r2.multipart-abort`、終了反映は`global:r2.write-settle`を使う。ControlDO内部からは同じinstanceへ直接接続する。

grant待機の上限は25秒で、送信開始期限自体は最大5秒。uploadのnative送信を開始した後は、元の最大15分の転送leaseまで待機する。GCと中止処理は25秒と呼出し元の固定期限を上限にする。timeoutはnative処理の中止や終了を意味せず、pendingを残す。生きている継続が後から実成功を受け取った場合は、その事実を終了RPCへ送る。nativeの拒否、RPC応答喪失、DO eviction、lease満了、HEAD不在だけではpendingを解消しない。

新しい6種類は`source_ref`に元のupload/attempt、または中止元/claim/handleを保存する。kindとsource_refの一意制約により、新しい要求UUIDでも同じ元試行を再送できない。送信されなかった別要求の`not_started`行だけは同じsource_refを許可し、拒否したgrantのローカル保留を確実に精算できるようにする。

probeの`source_ref`はepoch・元lease token・nonceを固定する。既存の64-byte永久割当、ETagによるCAS、60秒leaseを維持し、全検証の25秒期限をgrant待機で延長しない。停止challengeの残り時間が短い場合はそちらを上限にする。復旧のscopeをgrant受領後にも同期検査し、その直後にgrantの5秒期限を再確認する。閉鎖済みまたは期限超過ならnativeを呼ばずnot_startedを記録する。送信済みのPUTがtimeout後に実成功した場合は終了記録だけを反映し、S3読取りや検証済み証言を遅れて実行しない。新しいgenerationで接続を検証できても、過去の不明なPUTは独立したpendingとして保持する。

同keyにpendingがある間はuploadの予約解放・cleanup完了・GC handoffを拒否する。完成objectのphysical計上や既存のobject検証は可能だが、HEAD不在、成功した別のabort、UploadDOの停止だけでは古いnative保留を消さない。D1 triggerでも予約のreserved→releasedとcleanup_pendingの解除を拒否する。

BACKUPS削除は`ControlBackup.prune`と`ControlBackupSweep.step`の両方から接続する。D1のr2_keyは世代のmanifest keyとし、DO grantには実際の削除key全件を保持する。source_refはepoch・世代ID・元のprune試行ID・parts/manifest phaseを固定する。一度のDELETEで最大20部品、manifestは別のDELETEという既存の境界を維持し、同じ元試行の再送を拒否する。D1の全世代tuple・停止状態をgrant batch内で再検査し、送信直前にもDOの元状態と期限を確認する。全体25秒・I/O10秒の元期限を延長しない。pendingがあれば新しいprune/sweepも同じ世代で停止し、再一覧が空でもabsentを返さない。遅れた実終了の精算後に、次の要求が現在条件を再検査して回収を続ける。

BACKUPS probeの`source_ref`はepoch・復旧要求ID・元の試行ID・nonceを固定する。DOのwriting phaseに元の期待ETagを保存し、停止challenge・対象・leaseとともに再検査する。grantの5秒期限とRPC全体の元の25秒期限を延長しない。D1停止mirrorの相違で未送信事実を反映できない場合もDOへnot_startedを保持し、既知終了repairの対象にする。送信後のtimeout・取消しはnative終了と区別し、遅れた実終了だけを記録する。後からchallengeを発行したり、古い未知PUTを新しい接続確認で精算したりしない。

GCの結果不明DELETEは確認HEADへ進まず、deletingとphysical容量を保持する。claimの60秒leaseが切れても同keyを再claimせず、ゴミ箱復元のreadyも返さない。遅れた旧DELETEが実成功して終了記録が反映されれば、新しいclaimが現在の条件を再検査して回収できる。旧claimは期限・modeの相違で後続HEADや容量精算を行えない。orphanの最初のHEADで既に不在の場合は、同keyにpendingがなく、現在のclaim条件を満たすときだけDELETEなしで精算できる。

## 修復・保持・復旧への接続

内部`ControlDO.repairR2WriteSettlements(epoch, limit)`は停止中に既知の終了事実だけをD1へ反映する。既定20件・最大32件。R2を再送せず、unknownを推測で終了しない。`checked/reconciled/localPending/unknown/databasePending`を返す。公開HTTPや任意の保留解除コマンドは追加していない。

DOの使用済みIDは24時間、D1終端receiptはSQL時計で24時間保持し、一度に最大32件ずつ削除する。未精算receiptは期限で削除しない。長期間保持されたDO終了事実の修復中に、その照合対象をD1履歴の掃除で削除しない。

- DOにreceiptが一つでもあれば、復旧監査のページ処理、凍結intentの保存、受付再開を拒否する。
- D1のpendingはepochを問わず最終復旧query・restore freeze trigger・maintenance解除triggerで検査する。DO storageが全て失われても、D1に残るpendingで止まる。
- blob GCとorphan GCは同keyのpendingを候補選択・claim・送信前で除外する。D1の`deleting`と`deleted`への遷移にもguardを置き、未終了のまま物理精算できないようにする。
- tableにはbackup/restore双方の書込み凍結triggerを置く。保存済み世代のpending/succeeded/not_startedはオフライン復元でも維持する。過去世代は保存時のschemaを復元し、現在のcaptureは68tableを必須とする。

通常バックアップを新規開始するときも、intent保存前にD1のpendingとDOの未精算receiptが空であることを要求する。転送中に凍結するとnative終了のD1反映と元のopen policyへの復帰が互いに待ち続けるため、終了記録が残る間はbackup intentを作らず拒否する。生きている転送の終了記録はそのまま反映でき、解消後に同じbackup IDで開始できる。D1だけ・DOだけに残った記録も検査する。単なる未開始upload予約の満了は待たない。

migrationはmaintenance中、backup/restore freezeなし、open permit・claimed operation・未閉鎖mutation admissionなしで適用する。0042はGCの2種類とorphanのnull owner、UTF-8で最大1,024bytesのkeyを追加。0043はupload/multipartの6種類、bucket.abortのnull owner、source_refと一意制約、upload精算guardを追加する。0044はownerなしのprobe.put、0045はbackups.probe.put、0046はbackup.deleteと元試行の一意性を追加する。期限切れpendingと終端行は0042/0043では旧10列、0044〜0046ではsource_refを含む旧11列を双方向に照合して全行保持し、索引と全guardを再作成する。通常table数は増やさない。実環境へは未適用。新Workerは0046を前提とする。

移行は旧Workerから既に送信された処理の記録を後付けできない。実配備の切替えでは旧処理の終了確認も必要であり、tableが空であることだけを旧処理の終了証明にしない。

## 残る境界

外部CLI保存に向けた[専用送信受付](BACKUP_PUBLICATION_WRITES.md)をControlDOとprivate bindingへ追加した。D1全table凍結中もDO側にpendingを保持し、完了・解除・取消しを拒否する。実際のCLI PUTからこの受付を呼ぶ接続は後続であり、下記の既存送信点はまだ未統合。

この記録は上記14種類が対象。BACKUPSの外部CLI保存、epoch履歴などを含む全R2処理の最終終了証明はまだ統合していない。native結果自体が不明な試行を解消する運用証明も未実装。

最終停止への次の確認点は以下。通常の運用上の収束条件と、DB巻戻し前のnative終了証明を区別する。

| 既存の送信点 | コードで確認した境界 | 復元前に追加確認すること |
|---|---|---|
| `scripts/backup/publication.mjs` / `scripts/backup/objectStore.mjs` | part/manifestを固定key・hashで照合する。CLIの保存は元D1を凍結してから開始し、PUT応答喪失後も正確なobjectを読めれば保存済みとして進める | 凍結中はr2_write_attemptsとmutation_admissionsも更新できない。全table凍結を維持した外部の送信・終了証明を追加し、objectの一致を過去のnative終了へ読み替えない |
| `do/epochHistory.ts` | 新epochの履歴は条件付きPUTと正確なrecord照合で作る | 復旧要求に固定した事前予約と復元後のD1採用を分離し、遅延した古い発行を拒否する |

外部CLI保存の次の確認点は、D1凍結中に許可をどう保持するか、CLI終了・応答喪失後にどの永続記録で解除を拒否するか、遅れて返った実応答をどこで保存するか。S3BackupStoreは自動retryを無効にしているが、現在のtimeoutはAbortSignalとPromise.raceであり、外部PUT終了の証明ではない。

uploadでは短い送信開始許可、nativeの終了事実、本文/hash検証、公開の認可を元のattemptへ対応させた。結果不明の運用上の解消と、未知multipart全体の閉鎖・容量精算は別途必要。

成功したstagingの後で公開前に停止・障害となり、削除を開始できなければ未公開objectを保持する。既存inventoryと復旧監査の対象であり、台帳だけを消して公開済みまたは回収済みと扱わない。

新epochの事前予約、live D1上書き後の採用、全監査・段階再開、ControlDOとD1の両方が失われた場合の復旧、実Cloudflare運用検証は後続。[D1凍結](DATABASE_RESTORE_FREEZE.md)だけを実D1上書き許可として使わない。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。
