# 画像変換の費用・終了記録

2026-09-29。画像変換の有料呼出しを重複させないための内部基盤。D1 schema0068で`image_transform_attempts`、0069で失敗の終了記録を追加し、0068/0069時点は通常77table・147 route。[生成物のR2保存](IMAGE_DERIVATIVES.md)は0070で追加済み（78table）。[生成物の回収](IMAGE_DERIVATIVE_CLEANUP.md)は0071で追加済み（79table）。[Queueからのsm/md自動生成](IMAGE_QUEUE.md)は接続済み。[lg受付](LARGE_THUMBNAILS.md)、[thumb配信](THUMBNAIL_DELIVERY.md)、[Gallery](GALLERY.md)も接続済み。未知nativeの運用修復は後続で、公開HTTP内で有料変換を直接実行しない。

## 受付と費用の重複防止

`ControlImageTransforms.begin`は通常upload/DAV PUTの元Outboxに対して、元actor・credential・共有・parent・現在node/blob・blob step・R2保存記録・epochとclaim期限を確認する。原本のkey/etag/sizeと選択した変換寸法を固定し、通常のaccount mutation枠でD1のpending行と認可を一括確定する。権限を読んだ後の変更も同じbatchで拒否する。

grantを返す前に、ControlDOのSQLiteへ完全なidentityとblob×variant×generatorの費用キーを保存する。費用キーはpending・succeeded・failedの間はuniqueで、別claimや再配信も再実行できない。DOの記録はD1のバックアップ/復元対象外であり、巻戻し後の再課金も防ぐ。明示的なnot_startedの終了記録がある場合だけ同じ費用キーに新しいgrantを許可する。grant自体は再発行しない。

未精算は最大8件。全履歴は最大100万件で、満杯なら新規受付を拒否する。時刻・lease expiry・D1の欠落だけで古い費用記録を消さない。GC/保持期限を照合した履歴整理は未接続である。

## 実行と終了

`trackedImageTransform`は5秒以内に1回だけnative actionを開始し、invocationの25秒以下の期限を維持する。開始直前にも認可callbackを要求する。まだ実行していないgrantだけをnot_startedとして終了できる。grantのACK喪失は未確定のまま保持し、native actionを呼ばない。

正常な生成物はサイズ・寸法・SHA-256のreceiptで終了する。DOへ実終了を保存してから、全identity付きのD1 terminalを確定する。D1更新やRPCのACK喪失は、その同じterminalを読み戻す。D1確定に失敗してもDOの終了証拠を保持し、後から変換を再実行せずに精算する。

timeout後も実結果を得られた場合は終了の事実を記録するが、期限を失ったcallerへ生成物を返さない。次の終了証拠はfailedとして記録し、未精算枠を返す。費用キーを残すため同じ変換は再試行しない。

- native `.output()`が返した明示的な拒否（code 9401/9412/9413/9422/9432/9520、`IMAGES_TRANSFORM_` prefix）。入力ストリーム由来の例外を区別し、同じcode/messageを持つ入力エラーを終了証拠にしない。
- 入出力の双方をEOFまで取得した後の、生成物の形式・寸法・metadata検査の失敗。検査不合格の本文は公開しない。

`transformImage`のfailure observerを`trackedImageTransform`へ渡し、native Promiseの実拒否を観測する。callerのtimeout後に届く明示拒否も記録する。終了記録は全identityとfailure kind/codeを照合し、D1/RPC ACK喪失や復旧でも同じ証拠を回収する。nativeのエラー本文やprivate情報は永続化しない。

一般Error、接続切断、code9402/9523/9529等、EOF前の出力上限到達・中断・取消しはpendingを維持する。未確定結果の運用上の解決と、失敗後の明示的な再試行予算は未接続である。単なるError/timeoutを未実行扱いにしない。分類は[Cloudflareのエラー説明](https://developers.cloudflare.com/images/reference/troubleshooting/)と[workerdのbinding実装](https://github.com/cloudflare/workerd/blob/main/src/cloudflare/internal/images-api.ts)を確認した上で、明示拒否に限定している。実環境のcodec/拒否条件の検証は別途必要。

## 停止・バックアップ・復旧

新規受付はControlDOとD1の停止/epoch/freezeを確認する。終了事実は停止後も共通のglobal mutation枠で精算できる。local未精算記録またはD1 pendingがあればbackup開始・freeze・復旧後の再開・原本GCを拒否する。復旧監査、domain/inventory修復の事前確認にも含める。

`repairImageTransforms`と復旧native修復は、DOの終了証拠とD1の完全なidentityを照合する。pendingへ戻ったD1をsucceeded/not_started/failedへ直しても、ImagesもR2書込みも再実行しない。id/token/元blob/変換引数等が異なる行、DOの証拠が欠落した行は未確定のまま残す。復旧CLIは`live.images`と`databasePending.images`を表示し、画像変換が残る場合を完了判定から除外する。

## 移行と次の接続

0068は停止・未凍結・open permit/claimed operation/未閉鎖admission/未終了KDF/R2なしで適用する。0069はさらにpending画像変換なしを要求し、既存全列の完全一致を検査してテーブルを移行する。ControlDOは旧SQLite台帳を同期transactionで移行し、identity/cost key/grant/結果/mirror/履歴件数を保つ。適用前に独立DOの未精算も確認する。大量履歴での移行所要時間は未計測。export/purge順序とbackup/restore freezeを維持する。旧Workerへ戻す場合は停止を維持し、schemaとコードが整合する復元手順を使う。remote migrationは未実施。

immutable derivative keyへのtracked R2保存とphysical容量、current node/blob/claim/epochでの結果公開、sm/md Queueは接続済み。lg lazy受付、thumb ticket/配信、Gallery API/UIも接続済み。サムネイルは検査済み原本からサーバー側で生成する。
