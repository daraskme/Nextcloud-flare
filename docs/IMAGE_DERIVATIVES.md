# サムネイルの保存と公開記録

2026-09-29。`jobs/imageDerivative.ts`は、成功済みの[画像変換記録](IMAGE_COSTS.md)からWebP生成物を不変のR2 keyへ保存し、`derivative_results.ready`へ公開する内部処理。schema0070、通常78table・147 route。Queueでの自動生成、thumb byte配信、Gallery API/UIへはまだ接続していない。

## 受付と容量

保存前に元のimage attemptがsucceededであること、生成物のbytes・幅・高さ・SHA-256・WebP MIMEが記録と一致することを検査する。元upload/DAV PUTのactor・credential・parent・blob・Outbox claim/epochを、準備・native PUTのgrant・公開batchで再検査する。公開のためのnamespace LockDOは取得しない。

生成物は`u/<owner>/d/<sourceBlob>/<generator>/<variant>/<imageAttempt>`へ保存する。同じkeyを上書きせず、R2の`etagDoesNotMatch:*`とSHA-256を使う。生成物のblob ID、reservation、job pin、result ID、native write attemptを一括作成する。prepareの応答を失った呼出しはPUTへ進まない。生成物は通常のblob/storage台帳へ登録するため、R2 inventory、実容量、参照監査の対象になる。

生成物は論理ファイル容量に含めない。`reservations.physical_only=1`は`users.image_reserved_bytes`へ計上し、通常upload/copyの`reserved_bytes`と区別する。物理予算は`physical_bytes + reserved_bytes + image_reserved_bytes <= quota_bytes × 1.2`で全予約を検査する。通常ファイルの論理quotaが満杯でも物理余裕があれば生成できる。実際のR2 bytesはblob_storageで計上し、公開後に物理予約を解放する。入力のreference/used bytesは変えない。

## native書込みと公開

`image.put`を既存のControlDO R2 write ledgerへ追加した。準備済みtuple、元の認可、原本/claim、未使用key、容量予約、pinを同じgrant batchで検査する。別Workerや同じ要求の再送も、一度発行したnative attemptを再送できない。Imagesの実行費用とR2 PUTの記録を混同しない。

実PUTが返ったら、権限失効・期限・停止・epoch変更の後でも保存事実を記録する。key/etag/sizeを照合し、サイズやchecksumが期待と違っても観測した実bytesを計上して公開は拒否する。書込みの実応答が不明な場合、予約とpinとnative holdを保持する。存在確認や期限切れだけでPUTを再実行しない。

公開は元のactor/credential・現在node/blob/parent・Outbox claim・epoch・期限に加え、Images成功記録、R2の成功記録、保存済みsize/checksum/etag、生成物pinを検査する。blob committed、result ready、公開記録、予約解放を一つのbatchで確定する。公開済みreceiptの応答喪失は同じ確定記録で回収し、再PUTしない。

## 別のQueue要求からの公開再開

`resumeImageDerivative`は、同じOutbox通知を新しいclaimで処理する場合に、保存済み生成物の公開を完了する。元のImages/R2 grant、費用回数、予約期限は更新しない。新しいclaim tokenと最大25秒の公開期限を取り、元と同じ通知・epoch・node/blob/parent・保存時のactor/credentialを現在の状態で認可し直す。別通知や復元後の新epochへ元grantを移す用途には使えない。

ControlDOのprivate `imageDerivativePublicationProof` は、独立したImages成功identity/outputと、R2の全識別列をhashしたnative終了履歴を照合する。書込み停止sealがある場合、同じkeyの独立pendingがある場合、どちらかの履歴が欠ける場合は拒否する。D1の退役記録が失われても独立sealを優先する。これは書込みgrantではなく、Images・R2を再送する権限を持たない。

最後のD1 batchでも現在の認可・claim・原本・epoch・未凍結状態、元のnative write ID/token、保存サイズ/etag/SHA-256、物理予約・pin、未退役状態を照合する。resultのclaim更新、blob committed、result ready、公開状態、予約解放を一括確定する。実容量と費用履歴は増減しない。並行する古いclaimは公開できず、応答喪失は同じ確定receiptで回収する。公開済みの結果も現在の認可を確認して返し、既存receiptを書き換えない。

回収が先に退役を確定した生成物は再公開しない。公開が先に確定すれば、有効な原本に対する期限切れ回収は拒否される。preparedのままの生成物、観測欠落、未知PUT、失われた終了履歴はこの経路では推測せず保持する。native履歴の通常保持は36日で、削除後の復元をこの処理だけで解決できるとは保証しない。

## 保持と復旧

`image_derivative_objects`は元画像・生成物・result・reservation・native attemptの関係を保持し、費用/native記録の時刻による削除から保存証拠を保護する。生成物pinは期限だけで消さない。未公開の物理予約は一般の旧epoch reservation解放から除外し、専用の終了証拠がないまま返さない。復旧のowner監査では物理予約counterも予約行と照合する。

0071で[生成物の回収](IMAGE_DERIVATIVE_CLEANUP.md)を追加した。独立した書込み停止記録と未終了nativeの検査、観測が欠けた出力のHEAD、予約とpinの精算、35日猶予のGCへ接続している。native結果不明や独立履歴欠落は保留する。同じ通知の新claimからの公開再開は接続済み。Queue自動生成、費用履歴整理、失われた生成bytesの明示的な再変換予算は後続である。

## 移行と検証範囲

0070は停止・未凍結・未終了permit/operation/admission/KDF/R2/Imagesなしで適用する。既存R2 write表の全値を照合し、索引と参照triggerを再作成してimage.putを追加する。元の予約はphysical_only=0、画像予約counterは0で移行する。独立DOの未精算も適用前に確認し、旧Workerへ戻す際は停止を維持して対応schemaとコードを整合させる。remote migration/deployは未実施。

検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)に記録する。ローカルR2/Images、D1/DOの結果であり、実Cloudflareのcodec・費用・配備・最大履歴容量の証明ではない。
