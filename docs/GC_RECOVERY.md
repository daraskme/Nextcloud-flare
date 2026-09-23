# 停止中のGC回収

maintenance/GC pauseを解除せず、停止前に`deleting`へ進んだblob・未追跡objectの回収を完了する。新しいGC candidateやquarantined objectの削除は開始しない。ControlDOの内部RPCであり、公開HTTP/Cronから停止中回収を呼ばない。

| 内部RPC | 対象 | 1回の上限 |
|---|---|---|
| `drainBlobGarbageCollection(expectedEpoch, limit=20)` | `gc_candidates`と`blobs`がともにdeleting、旧claimのlease失効済み | 20 object、25秒、各delete+HEAD |
| `drainOrphanGarbageCollection(expectedEpoch, limit=20)` | 35日猶予経過済みの`orphan_objects.deleting`、claim失効済み | 20 object、20秒既定、各HEAD+delete+HEAD |

両RPCは前後で`beginRecoveryAudit`を実行する。ControlDOのcurrent epoch、D1 mirror、maintenance=1、gc_paused=1を要求し、監査を先頭へ戻す。active job leaseが残れば処理を始めない。受付再開は別の未実装gateであり、drain成功や監査完了だけでは再開しない。

## 通常blob

migration `0024`で`gc_candidates.claim_epoch`と単調増加`r2_calls`を追加する。既存claimのepochは推測して埋めず、lease失効後の新claimで設定する。通常GCと停止中drainは同じ回収本体を使い、期待するcontrolの停止flagと新しいcandidateを受け取れるかを分ける。

- claimは60秒。ref=0、全pinなし、materialized pinなし、削除中blob、immutable key、token、claim epoch、control epoch・modeを確認する。
- 対象uploadが未完了・予約保持中・cleanup claim中、または非完了multipartに閉鎖証明がない場合は回収しない。GC candidateだけを作ってuploadの予約holdを迂回できない。
- delete/HEADそれぞれの直前にD1 fenceとcounterを同じbatchで確定する。counterの応答が不明ならR2へdispatchしない。claim応答喪失は自分のtokenを再読して照合する。
- deleteの応答だけで物理容量を減らさない。HEAD不在を確認し、さらにcurrent fenceを再検証した同じD1 batchでblob/GC状態、`blob_storage.removed_at`、uploadのcleanup_pendingを確定する。
- final batchの応答喪失はblob/GC両方のdeleted、key一致、claim解除、未精算physical・cleanup_pendingがないことを照合する。rollbackなら容量を保持し、lease失効後に再試行する。
- 遅れた旧Workerは新しいtokenやepochを使えず、HEADのdispatch・最終精算を行えない。すでにdispatch済みのdelete自体を取り消すものではないため、deleting状態とkey再利用禁止は維持する。

通常稼働時も、claim取得後にGC pause/maintenance/epochが変われば後続dispatch・精算を止める。停止中drainは`candidate→deleting`を新たに進めず、7日猶予を短縮しない。

## 未追跡object

`drainStoppedOrphanGarbageCollection`は既存のHEAD照合・35日猶予・identity fence・counter・physical会計を使い、対象をdeletingだけに絞る。削除済みならHEAD不在だけで精算できる。既存の有効claim、所有者を解釈できないkey、未来epoch、猶予中のobjectは保持する。

HEADで別version/ETag/size/uploadedを見つけた場合は、新しい実容量を記録して35日の猶予を再設定する。その回では削除せず、deleting状態も維持する。このような外部置換や未解決claimが残れば復旧監査は完了しない。通常データへの同key再登録とtombstone削除は禁止したままである。

## 検証と残作業

実workerd D1/R2/ControlDOで、旧epoch回収、有効lease・pin・新候補の保持、claim/counter/final batch/R2応答喪失、同時回収、遅延削除、停止変更、容量の一度だけの精算を試験する。専用fixtureでblob・orphan双方の回収後に全復旧監査が完了し、maintenance/GC pauseは維持されることを確認する。

未知multipartの全体閉鎖・予約精算、Queueの完全なdrain、ControlDO再開、実Time Travel/logical restore drillは残る。空のmultipart一覧や日数だけでこれらの完了を推測しない。特に[S3 AbortMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html)には進行中partとの競合時に再確認が必要な場合がある。R2での保証と実サービスの検証はfixtureだけで代替しない。
