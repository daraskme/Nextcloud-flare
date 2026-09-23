# Completed-object inventory

`jobs/orphanInventory.ts`とmigration `0021`は、`u/`以下にある完成済みR2 objectのうち、`blobs` / `derivative_results` / `archive_index` / `target_sets`のどこにも属さないkeyを隔離する。incomplete multipartの一覧・閉鎖証明は別契約で、ここから予約容量を解放しない。

## 発見と容量

`r2_inventory_scan`はepoch、opaque cursor、60秒lease/token、ページ確定tokenを保存する。`scanOrphanObjects`は1回につき既定20・最大100件を走査し、未知keyはHEADで現在のsize/etag/version/uploadedを確認して`orphan_objects`へ記録する。完了したpassの次回は1時間後。maintenance RPCはこの待機時間を省略して残りのpageを続行できる。旧epochのcursorは新epochで先頭からやり直す。

ページ内の観測は個別に原子的に保存し、全objectを処理した後だけcursorを進める。中断・HEAD失敗・不正ページではcursorを維持し、再送でも初回発見時刻と容量を重複計上しない。cursor確定応答が失われた場合は同じtoken/cursor/epochを照合する。各batchはcurrent epoch/maintenanceとscan leaseを再検査する。さらにHEAD前のorphan行のstate/metadata/観測時刻を保存時に照合し、並行GCが置換・削除を記録した後へ古いHEAD応答を反映しない。

保留期間はR2のupload時刻ではなく、**発見時から35日**。同じobjectの再検出では延長しない。version、etag、bytes、uploadedが変わった場合と削除済みkeyが再出現した場合は、その時点から35日を数え直す。versionは同size・同ETagの置換も区別する。[R2Objectの定義](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#r2object-definition)に従う。

`u/<owner>/b/<blob>`のkeyから既存ownerを特定できれば、D1 triggerで`users.physical_bytes`へ実bytesを計上する。logical/reservedは変更しない。既存のblob物理行とorphan物理行の合計をowner監査で照合する。owner不在でも論理owner keyを保存し、同IDのuserが後で復元されたときはtriggerで一度だけ計上する。不正なkeyはownerを推定せず記録し、自動削除・復旧監査の完了を許可しない。

## 回収と競合

通常blobの7日GCとは独立した`collectOrphanObjects`が35日後に回収する。current epoch、maintenance解除、GC pause解除、全catalogueからの独立を確認し、60秒claimを取得する。HEADで保存済みversion等を再検査し、一致した場合だけdeleteする。置換を発見した場合は新しい実サイズを計上し、35日の猶予を更新する。

各R2 callの直前に、epoch/pause、claim token/lease、object identityを再検査してcounterを確定する。counter応答が不明なら新しいI/Oを発行しない。delete応答喪失でもHEAD不在を確認できれば収束し、HEAD不明やDB精算失敗なら物理容量を保持する。削除済み状態と物理容量の減算は同じD1 batchで確定し、失われた確定応答は保存済みの全object tupleで照合する。

隔離keyは通常blobや他catalogueへ登録できず、逆にcatalogue登録が先に確定したkeyは隔離しない。この排他をD1 triggerで強制する。削除後もkeyのtombstoneを残し、遅れたGCと新規uploadが同じkeyを使わないようにする。R2はアプリが管理する不変keyとして扱う。管理外のwriterがHEADとdeleteの間に同じkeyを書き換える運用は、この仕組みの保護対象にできない（Workersのdelete APIに条件指定はない）。

## 接続と残る境界

Cronはadmission後に1ページ走査し、GC許可後に回収する。`ControlDO.inventoryOrphanObjects(epoch,limit)`はquiesceと監査の前後初期化の下で走査だけを行い、削除・admission再開をしない。復旧のR2監査は、隔離済みkeyのsize/etag/version/uploadedを完全一致で照合する。最終fenceは未完了のscan/GC claim、deleting、不正key、未来epoch、owner会計漏れを拒否する。

このcheckpointは完成済み`u/` objectのinventoryを接続したもの。unknown multipart IDの全体閉鎖/予約精算、その他prefixの未追跡生成物、catalogueに残るkeyの不正な置換、ControlDO再開、実bucketのlifecycle/restore試験は引き続き必要。S3の既存upload未知ID走査・中止と、停止中の既存deleting回収は追加済み。forward migrationとexport/purge順序に2tableを追加済みだが、実backup/export/restore実装・演習は未完了。

## 停止中の削除完了

`ControlDO.drainOrphanGarbageCollection`は、すでにdeletingへ進んだobjectだけをmaintenance/GC pause中に回収する。新しいquarantined objectは対象外で、35日猶予とHEAD identity照合は維持する。詳細と試験範囲は[GC_RECOVERY](GC_RECOVERY.md)。
