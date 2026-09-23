# 通常稼働中のごみ箱復元とGC

更新: 2026-09-24。ローカル実装の契約。実Cloudflareでの移行・配備・復旧訓練は未実施。

## 一時停止の所有者

復元はControlDOから期限付きのGC一時停止を取得する。通常の受付は維持するが、新しいGC candidateの削除開始を止める。全体の`gc_candidates.state='deleting'`が0件になるまでは復元しない。削除済み・削除中のblobを参照するtrashは`409 blob_unrecoverable`で拒否し、不可逆なblob状態を戻さない。

migration `0026`はD1 `control`に`gc_operator_paused`と`gc_hold_token/operation/expires_at`を追加する。通常tableは61のまま。DO SQLiteの`control_gc_policy`は同じepochの管理者設定・一時停止識別子・遷移前GC値を保持する。既存のadmission revision/tokenと組み合わせ、ローカルintentを保存してからD1の直前revision/token/flagsへCASする。D1だけの書換えでは稼働許可を得られない。

全体GCの停止を必要とするため、同時に所有できる復元operationは1件。識別子はoperation ID・ランダムtoken・epoch・固定期限の組であり、HTTP応答には出さない。同じoperationの再試行は同じ識別子を再利用し、再試行だけで期限を延長しない。既定期限は5分。別のoperationは`503 gc_quiescing`と`Retry-After: 5`を受け取る。

## 復元の順序

1. 現在のcredential・trash membership・復元先権限と、同じIdempotency-Keyの保存済み結果を確認する。terminal結果の再照会では新たにGCを止めない。
2. `ControlDO.acquireRestorePause(epoch, operationId)`が一時停止を永続化する。管理者によるGC停止設定は別に保持する。
3. 有効な削除leaseを待ち、期限が切れた既存`deleting`だけをdelete/HEADで収束する。1回最大20件、新規dispatchの時間枠は25秒。進行中のR2呼出しの強制中断は保証しない。新規candidate、pin付きblob、未精算uploadは処理しない。残件があれば識別子を保持して503を返し、同じkeyでの再試行を可能にする。
4. LockDOのpermit付与batchとD1の原子的な復元batchの両方で、同じoperation/token/epoch/期限が現在も有効であることをassertする。既存の認可・permit・membership・全体GC停止・削除中blob拒否も維持する。
5. 復元試行終了時に同じtokenだけを解放する。D1の識別子削除とGC設定変更は同じbatch。古い処理が後から届いても別operationの一時停止を利用できず、解放後の遅延commitも拒否される。

管理者がGCを止めていた場合は、復元後も止めたままにする。復元中の`pauseGarbageCollection`は管理者設定を保存する。hold中の明示的な`resumeGarbageCollection`は`gc_restore_busy`で拒否する。通常停止・epoch更新はholdを取り消し、監査後の段階的な再開を必要とする。

## 応答喪失・中断

一時停止・解放はD1 dispatch前に5秒後のdurable alarmを予約する。batch応答が不明な場合は同じ保存済みtupleで照合する。readbackも失敗した場合はintentを残して受付を閉じ、alarmまたは同じRPCの再送で収束する。

alarmは未完了のGC変更を再照合し、必要なら既存削除をboundedに進める。operationがterminal、または期限切れならholdを解放する。期限切れの識別子はSQL時刻でも無効になり、GC再開前に確実に削除される。期限切れ処理が別の新しいholdへ紛れ込むことはない。DO evictionでtokenを作り直さず、全保存領域喪失では新epochと閉じた受付から復旧する。

R2へ既に出たdeleteは取り消せないため、対象keyは不可逆な削除状態のまま扱う。旧deleteの応答が新しい回収後に届いても、claim token/epoch/modeの再検査でHEAD・最終精算を拒否する。physical bytesは現在の回収処理がR2不在を確認した後、D1で一度だけ減算する。

## 検証範囲と残る制約

`restore-gc-pause.test.ts`は実ControlDO/LockDO/D1/R2で、稼働中復元、同じkeyの再送、管理者設定、競合operation、期限切れ、commit/readback応答喪失、eviction/全喪失、遅延pause/release対停止・新hold、permit/commit直前の識別子変更、旧R2 delete、HTTP待機と再試行を検証する。schema testは一部だけのhold・範囲外期限を拒否する。Filesのbrowser fixtureもGCを再開し、復元前後の状態と復元応答喪失後の再照会を検証する。

- holdは単一であり、別ユーザーの復元も一時的に待つ。大量の既存削除や外部サービス障害では5分を超え、再試行で新しいholdが必要になる。
- 現在の復元は最大1,000ノードの同期処理。account単位のadmission、管理者画面、大量データと実R2での負荷・障害試験は残る。
- 災害復旧、Time Travel/logical export、未知multipartの閉鎖証明・予約精算は別の未完了範囲。
- migrationは受付停止中に適用し、Worker/DOの対応版と揃える。旧Workerはholdを理解しないため、そのままの混在運用や稼働中rollbackは行わない。実環境の切替手順はstaging gateで確認する。
