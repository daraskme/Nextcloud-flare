# multipart中止の実成功記録の回復

更新: 2026-09-28。migration0047・通常69table。

[復元後のinventory](DATABASE_RESTORE_INVENTORY.md)で、R2の中止は実際に成功したがdomain側の保存が失敗した場合を回復する。`uploads`と、同じ`handle-id`/`attempt-id`を指定する`abort`から実行し、新しいoperator権限や自動中止試行は追加しない。

## 証拠と保存

`restoreInventoryAbort.ts`はD1の元の実成功tupleから、id/token/epoch/owner/kind/key/dispatch期限/開始時刻/source_refの9項目をhash化する。独立したControlDOのNativeHistoryに同じhash、succeeded、同じ期限が必要。欠落・別identity・not_started・期限の相違は成功へ変換しない。

- bucket中止は元attemptとhandle、source、key、同じnative epoch、owner=nullを照合する。成功を`multipart_bucket_abort_reconciliations`へ保存し、元attemptのstarted/unconfirmedとエラーを残す。補足記録は変更・削除できず、1attemptに1件、1nativeに1件だけ。再起動・再送時は保存済み記録を読み、R2中止を送らない。
- upload inventoryは同じowner/key/upload/不変handleへ紐づく元inventory abortを照合する。中止の予算確定時に保存した接続先とtokenも照合する。これにより古いcleanup tokenやscan roundの実成功を、新しいclaimで再確認できる。導入前でこの対応が欠ける記録は成功へ昇格させない。handleをabortedへ進め、再中止しない。D1に成功tupleがあるのに独立履歴が一致しなければ、そのuploadの処理を保留する。`uploads.aborted`にはこの照合で成功を回復したhandleも含み、`r2Calls`は再送分を加算しない。
- 保存前に共通system/global受付を取得し、要求の同じ停止epoch/revision/token、freshなBLOBS/S3対応証明、元tuple、domain identity、native pendingなしを同じD1 batchで再検査する。新しいbucket補足記録にもbackup/restore freeze guardを適用する。
- 保存応答が失われた場合は自分の共通受付の確定記録でDB-only更新を回復する。元の成功tupleがD1から失われている場合、DOに残るhashから復元したり、別handleの成功を使ったりしない。

補足記録はsnapshot/export契約へ含める。R2の24時間終端台帳が後日整理されても、確定済みdomain receiptと補足記録は保持される。新しい補足記録を作る時点では元tupleと独立履歴の両方が必要。

## 全体閉鎖との境界

回復するのは特定の中止の成功だけ。upload予約、partの最大観測容量、quarantine、scan/handleの削除拒否、復旧の最終停止条件を維持する。

全体精算の実装には、少なくとも次の証拠を同じ停止区間へ束縛する必要がある。

1. 対象bucketで発行済みのcreate/part/complete/abortすべての終了と、新規dispatchの停止。snapshotにないtupleや実行履歴導入前の呼出し、全DO喪失は別途解決する。
2. fresh bindingとsourceを固定した全handleの走査・処置、およびその後の不在確認。途中cursorや以前のscan完了を証明へ昇格させない。
3. 完成objectの観測・physical会計と、未完了part保留の精算を区別し、同じkeyに完成物がある場合も容量を失わない。
4. 上記を原子的な閉鎖receiptへ保存し、再実行時の二重返金・停止変更後の遅延保存を拒否する。既存holdを外すmigrationはこの証明と一緒に実装する。

2026-09-28に[Cloudflareの整合性仕様](https://developers.cloudflare.com/r2/reference/consistency/)と[Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)を再確認した。前者はobject一覧の強い整合性、後者はcreate後のmultipartへの即時アクセス、中止・完了のPromiseの意味を説明している。ただし、未知の進行中呼出しを含む全体閉鎖を空のmultipart一覧だけで判断できる保証は今回確認できていない。[AWSの中止仕様](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html)も進行中partとの競合を説明するが、R2固有の全体閉鎖保証としては扱わない。これは保証の範囲についての実装上の判断である。

実S3での整合性・lifecycle・権限・遅延競合の検証と上記の閉鎖/精算は残る。今回のテスト結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)に記録する。
