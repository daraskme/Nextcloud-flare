# upload公開失敗後の精算

更新: 2026-09-25。private single/multipartのcompleteに接続。公開共有は後続。DAV PUTは[別の内部経路](DAV_UPLOAD.md)へ接続済み。

単一・分割uploadで公開operationの失敗が確定した後の精算を共通system受付へ接続しました。実際の所有spaceで通常操作と同じ32 active/256 waiting枠を取得し、upload・blob・予約解放・確定記録を一つのbatchで保存します。

## 実行契約

completeSingleUpload/publishMultipartUploadからCONTROLを必須で渡し、内部settleFailedCompletionはSystemMutationSourceで受け付ける。元のnamespace permitが閉じた後や保存済みfailed operationの再照会でも、自分のsystem:upload.complete-failed受付が必要になる。actorとownerが異なっても実ownerのspaceを使う。空いていない場合のDB-only迂回はない。

待機後に元のupload/owner/space/credential/epoch/予約と失敗operationのoperand・step不在を再検査します。最初の予約解放には一致するblob_storageの物理計上を必須とし、singleは検証済みhash、multipartは独立した完成object proofを要求します。公開結果不明・転送中・参照済みblob・証拠不足では解放しません。精算済み結果は追加受付なしで読み、GC後も再照会できます。応答喪失は自分の確定記録または厳密な終端を照合し、他の精算で自分の未確定枠を返しません。混雑はHTTP503/Retry-Afterで予約とphysicalを保留し、再試行でR2送信・削除を繰り返しません。

## 予約を解放する証拠

同一batchで元のupload ID・owner・space・parent/target・blob・reservation・credential・epoch・mode・size・request digest・write attempt・期限・target revision・multipart ID/complete attempt/object etagを束縛する。completion_op_idは明示引数で照合する。呼出し元がoperation ID保存前のUploadRowを持つ場合もあるため、古いrow.completion_op_idには依存しない。

現在epoch・停止中の転送・実space所有者・予約のowner/bytes/epoch/期限・private予約・blobのowner/key/size/ref_count=0と、failed upload.complete operationのcredential/epoch/space/operand・step不在を検査する。claim中やcommittedのoperationは補償しない。初回解放にはreserved予約、staging/orphan blob、未除去の一致するblob_storageが必要。singleはwhole hash、multipartは独立したobject proofを要求する。容量counter driftも全体rollbackになる。SQL条件を意味ごとに括り、D1のexpression depth上限内に収める。

受付は現在のsystem mode/epoch/有効期限に束縛される。内部の既知事実の精算はowner無効化後・停止中にも可能だが、公開APIの認可条件を回避する入口ではない。旧source epochの補償は行わず、別の停止中cleanupへ渡す。

## 応答喪失と再照会

精算と自分の確定記録・枠返却は原子的に保存する。DB-onlyの応答喪失はexact receiptで照合し、読めなければ元のupload/operation/reservation/owner/spaceに一致するfailed・released・orphan/deletedの終端を照合する。他の処理が終端を確定していても自分のunknown枠を明示解放しない。両方の証拠が読めなければ成功を報告しない。

最初に精算済み終端を読むため、全32枠の占有中・ControlDO eviction後も再照会で枠を増やさない。GCでblobがdeletedになりphysicalが精算された後も終端照会を続けられる。この読取りを新しい予約解放や外部dispatchの証明には使わない。通常のGCと同じく、physicalの解放は実際の削除・不在確認を行う別処理の責務である。

## 検証と残作業

workerd51件を追加（境界46件・実ControlDO4件・HTTP1件）。関連109件（66.06s）と実ControlDO4件に加え、全体checkが成功。Node422件（25file、6.20s）・workerd1,898件（87file、990.88s）、計2,320件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。

境界試験は受付不能、ACK/rollback/receipt喪失、両証拠喪失、owner無効化、epoch/mode/受付失効、object/physicalの不一致、転送中・参照・operation step、未知/確定済みoperation、counter drift、GC後・他処理完了後の再照会を検査する。実ControlDOは共有枠満杯とevictionを検査し、HTTPは503/Retry-After、namespace permit返却、同じoperationへの再試行、追加R2 I/Oなしを検査する。

旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OSクライアント・実環境検証・公開は後続です。
