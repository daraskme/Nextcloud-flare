# 空ファイル・配信manifest・GCのR2書込み記録

更新: 2026-09-27。migration `0041`〜`0042`、通常68table。空ファイルPUT・target manifest PUT・未公開manifest DELETE・blob/orphan GCのDELETEを送信前から記録し、結果不明のまま復旧凍結・受付再開・対象GCへ進むことを防ぐ。

## 接続した送信点

| 操作 | 送信条件 | 完了の扱い |
|---|---|---|
| `createLockedEmptyFile` | 元のLockDO permit・認可に加え、実ownerの共通受付と永続grant。既存keyを上書きしない条件付きPUT | native PUT成功だけを終了記録へ送る。条件不成立の`null`は終了したno-opで、既存の空objectをHEADで検証する |
| `stageTargetManifest` | 新しいUUID key・実owner・現epochで共通受付と永続grant。保持中の履歴と同じkeyを使うPUTは拒否 | 条件付きPUTの終了を記録後、従来のmanifest読戻し・hash検証・ticket公開へ進む |
| `discardUnpublishedManifest` | 従来の公開取消しbatchの直接ACKを維持。成功したstagingのowner/key、未公開、同keyのpendingなしをD1で再検査 | 専用global受付でDELETEを記録する。安定したmaintenance中も回収できるが、復旧凍結中は新規受付しない |
| blob GC（通常・停止中・ゴミ箱復元中） | 元のGC予算ACK後、実owner/key/blob ID、claim token/epoch/lease、ref/pin、未精算upload、現在の停止modeをgrant batchで再検査。復元中は元のoperation/token/期限も要求 | `blob.delete`を記録し、実際のDELETE成功と終了記録の反映後に確認HEADと容量精算へ進む |
| orphan GC（通常・停止中） | 明示null owner、35日猶予、解釈可能なowner key、旧epochまたは現epoch、claim token/lease、全object tupleとcatalogueからの独立を再検査 | `orphan.delete`を記録。owner未復元やUnicode keyも扱い、結果不明のDELETEをHEADで解消しない |

条件付きPUTの不成立は`null`を返すという[R2 Workers APIの契約](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)を利用する。例外になったPUTの後にobjectが見えても、その呼出しが終了した証明には使わない。

## 送信前と終了後の順序

1. Workerが新しい要求UUIDと最大5秒の開始期限を作る。GCでは呼出し元の固定期限と復元pauseの期限も上限にする。ControlDOはowner・kind・key・epoch・GC証明を検証し、token付きの`pending`を自身のSQLiteへ同期保存する。
2. 通常操作と同じ共通mutation枠でD1の`r2_write_attempts`へ正確な試行を記録する。D1 batchの直接ACK、現行受付、期限を再確認してからgrantを一度だけ返す。読み戻したreceiptから送信許可を再発行しない。
3. Workerはgrantの全フィールドと期限を確認して、一度だけnative R2処理を呼ぶ。戻る前に期限切れとなったgrantは`not_started`。grant応答自体を失った場合は送信せず、記録を残す。
4. native Promiseが成功した場合だけ`finishR2Write(..., "succeeded")`を呼ぶ。ControlDOに終了事実を先に保存し、共通global受付でD1へ反映する。正確なD1終端行を照合後、DOのreceipt削除と使用済みID保存を一つのtransactionで確定する。

beginのD1更新が失敗し、grantを一度も返していない場合は`not_started`を永続化する。D1の終端行は遅延した同IDのINSERTを主キーで拒否する。開始batchのACK喪失を再送許可へ変えない。

DOの未精算receipt・D1のpendingはそれぞれ全5操作で共有する最大32件。空ファイルの同keyへの並行条件付きPUTは個別の試行として数える。開始・終了のD1処理には既存の32 active/256 waiting枠を使い、R2待機中はその短期枠を保持しない。GCの開始は`global:r2.gc-delete`、終了反映は`global:r2.write-settle`を使う。ControlDO内部からは同じinstanceへ直接接続する。

Workerの待機上限は25秒で、GCは元の固定期限までの残り時間も上限にする。timeoutはnative処理の中止や終了を意味せず、pendingを残す。生きている継続が後から実成功を受け取った場合は、その事実を終了RPCへ送る。nativeの拒否、RPC応答喪失、DO eviction、lease満了、HEAD不在だけではpendingを解消しない。

GCの結果不明DELETEは確認HEADへ進まず、deletingとphysical容量を保持する。claimの60秒leaseが切れても同keyを再claimせず、ゴミ箱復元のreadyも返さない。遅れた旧DELETEが実成功して終了記録が反映されれば、新しいclaimが現在の条件を再検査して回収できる。旧claimは期限・modeの相違で後続HEADや容量精算を行えない。orphanの最初のHEADで既に不在の場合は、同keyにpendingがなく、現在のclaim条件を満たすときだけDELETEなしで精算できる。

## 修復・保持・復旧への接続

内部`ControlDO.repairR2WriteSettlements(epoch, limit)`は停止中に既知の終了事実だけをD1へ反映する。既定20件・最大32件。R2を再送せず、unknownを推測で終了しない。`checked/reconciled/localPending/unknown/databasePending`を返す。公開HTTPや任意の保留解除コマンドは追加していない。

DOの使用済みIDは24時間、D1終端receiptはSQL時計で24時間保持し、一度に最大32件ずつ削除する。未精算receiptは期限で削除しない。長期間保持されたDO終了事実の修復中に、その照合対象をD1履歴の掃除で削除しない。

- DOにreceiptが一つでもあれば、復旧監査のページ処理、凍結intentの保存、受付再開を拒否する。
- D1のpendingはepochを問わず最終復旧query・restore freeze trigger・maintenance解除triggerで検査する。DO storageが全て失われても、D1に残るpendingで止まる。
- blob GCとorphan GCは同keyのpendingを候補選択・claim・送信前で除外する。D1の`deleting`と`deleted`への遷移にもguardを置き、未終了のまま物理精算できないようにする。
- tableにはbackup/restore双方の書込み凍結triggerを置く。バックアップはpending/succeeded/not_startedを保存し、オフライン復元でも維持する。古いschema0037〜0041の世代は保存時のschemaを復元する。現在のcaptureは68tableを必須とする。

migrationはmaintenance中、backup/restore freezeなし、open permit・claimed operation・未閉鎖mutation admissionなしで適用する。0042は既存tableを再構築して2種のGC操作、orphanだけのnull owner、UTF-8で最大1,024bytesのkeyを許可する。期限切れpendingと終端行も全フィールドを照合して保持し、索引と全guardを再作成する。通常table数は増やさない。実環境へは未適用。新Workerは0042を前提とする。

移行は旧Workerから既に送信された処理の記録を後付けできない。実配備の切替えでは旧処理の終了確認も必要であり、tableが空であることだけを旧処理の終了証明にしない。

## 残る境界

この記録は上記5操作が対象。upload、multipart、binding probe、BACKUPS保存、epoch履歴などの既存台帳を含む全R2処理の最終終了証明はまだ統合していない。native結果自体が不明な試行を解消する運用証明も未実装。

最終停止への次の確認点は以下。通常の運用上の収束条件と、DB巻戻し前のnative終了証明を区別する。

| 既存の送信点 | コードで確認した境界 | 復元前に追加確認すること |
|---|---|---|
| `services/uploads/content.ts` / `services/putFile.ts` | 単一uploadとDAV PUTは元のwrite attempt・転送leaseでstreamを送り、objectの検証と公開を別に行う | native PUTの終了とstream/hash検証を分ける。HEAD/GETからのobject回収や期限切れcleanupによるin_flight解除を最終終了証明にしない |
| `services/uploads/multipart.ts` / `multipartComplete.ts` | create/part/completeの送信点があり、UploadDOはpartのunknownを保持する。completeの例外後も完成objectを照合する | 各native呼出しの終了を既存attemptと対応させる。観測済みobjectやUploadDOの状態だけで未知の過去呼出しを消さない |
| `jobs/multipartCleanup.ts` / `multipartInventoryRepair.ts` / `multipartBucketAbort.ts` | 既知ID回収・所有uploadの未知ID調査・全bucket調査でabortを行う。multipart作成後のID保存失敗時にも緊急abortがある | abort自身と進行中create/part/completeの終了を別々に追跡する。handleの閉鎖receiptや部品一覧を全呼出しの終了へ読み替えない |
| `jobs/r2BindingVerification.ts` | CAS、nonce、generationと60秒leaseを持ち、期限後には新しいgenerationを開始できる | 期限を超えた過去のPUTと現在のproofを区別し、全試行の終了を最終停止へ保持する |
| `backup/prune.ts` / `scripts/backup/publication.mjs` | part/manifestを固定key・hashで照合し、削除後の一覧で世代不在を確認する | Worker側の削除と外部operator側の保存の双方を停止対象へ含める |
| `do/epochHistory.ts` | 新epochの履歴は条件付きPUTと正確なrecord照合で作る | 復旧要求に固定した事前予約と復元後のD1採用を分離し、遅延した古い発行を拒否する |

uploadへ拡張するときは既存の転送lease（単一/partは最大15分）と、DAVの本文転送後に公開permitを取得する契約を維持する。現在のGC用25秒待機上限をそのまま長い本文転送へ適用しない。短い送信開始許可、nativeの終了事実、本文/hash検証、公開の認可をそれぞれ元のattemptへ対応させる必要がある。

成功したstagingの後で公開前に停止・障害となり、削除を開始できなければ未公開objectを保持する。既存inventoryと復旧監査の対象であり、台帳だけを消して公開済みまたは回収済みと扱わない。

新epochの事前予約、live D1上書き後の採用、全監査・段階再開、ControlDOとD1の両方が失われた場合の復旧、実Cloudflare運用検証は後続。[D1凍結](DATABASE_RESTORE_FREEZE.md)だけを実D1上書き許可として使わない。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。
