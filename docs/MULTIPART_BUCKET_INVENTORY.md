# upload行が失われたmultipartの観測・中止・容量保留

更新: 2026-09-25。migration `0027`と`jobs/multipartBucketInventory.ts`で、D1のupload行がない未完了multipartも保存先の`u/`全体から発見し、各partの観測済み容量を保留する。migration `0028`と`jobs/multipartBucketAbort.ts`で発見済みhandleの中止と不変receiptを追加した。全体不在の証明と容量精算は未実装。実S3試験・remote migration・deployは行っていない。

## 呼出しと範囲

停止中のControlDO内部RPCを使う。HTTP、管理UI、Cronへの接続はまだない。

```ts
await control.inventoryMultipartBucket(epoch, 20);
await control.observeMultipartBucketParts(epoch, handleId, 20);
await control.abortMultipartBucketHandle(epoch, handleId, attemptId);
```

最初のRPCは`{ inventory: { examined, completed, handles }, audit }`、次は`{ observation: { observed, heldBytes, completed }, audit }`を返す。`handles`はD1のUUIDと`tracked`/`quarantined`の組で、R2 upload IDは返さない。`completed`はその一覧走査の最終ページに達したことだけを表す。handleの閉鎖やbytesの不存在を意味しない。

各呼出しはmaintenance・GC pause・current epochを要求し、[fresh nonceによるBLOBS/S3対応検証](MULTIPART_INVENTORY.md)を毎回行う。既存の60秒probe leaseで直列化し、counter更新の確認後だけS3へdispatchする。保存とcursor更新は同じproof/scan snapshot fence付きD1 batchで確定する。ControlDOは処理の前後に復旧監査を初期化する。

1回に1ページ、既定20・最大100件。既存S3 clientのXML・echo・marker検査、1 MiB・10秒上限、redirect/retry禁止を使用する。probe検証のGETはこの一覧GETとは別。設定と資格情報は[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md)と同じ。

## 共通global受付

全bucketの未完了multipart調査・中止を共通global受付へ接続しました。scanとpartの開始・外部予算・ページ保存、中止の開始・結果保存の8経路が、通常操作と同じ32 active/256 waiting枠を使います。

所有者が未復元でもscopeは明示nullです。受付待ち後にfresh proof・epoch/mode/pauseとscan/partの元のround・cursorを再検査します。S3一覧とR2 abortは直接ACK後だけ送信し、probe開始から固定25秒の開始期限を受付後・ACK後にも検査します。初期化と中止結果のDB-only更新は自分の確定記録だけを照合し、一覧の結果付きbatchは応答喪失時に推測で成功を返しません。同じ中止attemptは再送せず、64回の生涯上限と容量保留を維持します。ControlDO内部は同じinstanceの受付を使います。

初回scan作成と完了後のresetも受付対象。所有者不在でも架空のspaceを作らず、通常のowner付きsystem更新と同じpoolで待つ。新しい中止は待機後に完了したscan/part走査を再検査する。結果保存は元のattempt/proofの記録であり、scan/partの新しいroundへ付け替えない。

workerd82件を追加（境界73件・実ControlDO9件）。関連109件（97.66s）と全体checkが成功。Node422件（25file、5.68s）・workerd1,780件（83file、971.26s）、計2,202件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。

## 永続台帳

| table | 保存する情報 |
|---|---|
| `multipart_bucket_scan` | source/epoch/round、KeyMarkerとUploadIdMarker、ページ数、完了時刻、累積dispatch counter |
| `multipart_bucket_handles` | source/key/upload IDごとの不変identity、Initiated、所有者、隔離状態、観測round、保留容量、part cursor/round/counter |
| `multipart_bucket_parts` | handle/part番号ごとの最大観測bytes、直近のbytes/ETag/更新日時/round |
| `multipart_bucket_abort_attempts` | callerのattempt UUID、handle/ordinal、epoch/proof/scan/part snapshot、開始時刻、結果と終了時刻。1 handleで生涯64件まで |

一覧は既知handleも記録する。D1に**keyとR2 upload IDが両方一致するupload**がある場合だけ`tracked`にする。同じkeyの別IDは`quarantined`。一度隔離したhandleは、遅れて元のIDがD1へ反映されても自動でtrackedへ戻さない。trackedは今回のpart観測対象外であり、既存uploadの会計を使用する。

source・epoch変更や走査完了後の次呼出しは新roundを先頭から始める。古いsourceのhandle/bytesは残し、別sourceからpartを観測しない。同じroundで前ページのhandleが再登場すればページ全体を拒否する。異なるInitiatedへの置換も拒否する。source変更後の重複観測は保守的な過大保留になり得るため、将来の精算で証明に基づく照合が必要。

## 容量と再利用の制約

各partは`max(以前のbytes, 今回のbytes)`を保持し、handleの合計とownerの`physical_bytes`へ差分だけ加算する。owner ledger監査もこの合計を含む。現在の正確なstorage総量ではなく、観測履歴に基づく保守的な保留である。未観測のpartや遅延送信があり得るため、全量を観測した保証にはしない。

- partの縮小・消失、空一覧、404/NoSuchUpload、応答喪失では容量を減らさない。
- partがまだ未観測なら`part_round_id`はNULL、`held_bytes=0`。未完了容量がゼロという証明ではない。
- `u/{owner}/b/{blob}`だけを所有者へ対応させる。user行が失われていれば未帰属で保持し、後日userが復元された時に一度だけ計上する。不正形のkeyは未帰属のまま隔離する。
- handle/partの削除、容量減算、identity変更、隔離解除をDB triggerで拒否する。整数上限を超えるページは全体rollbackする。
- 隔離keyでのblob新規作成・stagingからのcommit、derivative/archive/target manifestの新規登録・key変更を拒否する。
- 観測RPCはnamespace公開、R2 abort/delete、reservation解除を行わない。別の中止RPCもhold・reservation・quarantineを維持する。完成済みobjectの観測・回収は既存のobject inventory/GCが担当する。

復旧の最終D1 fenceは未完了scan、旧epoch/source、隔離handle、元のuploadとの対応が失われたtracked handleを拒否する。**0 bytesの隔離handleも再開を止める**。走査を開始していないDBに全bucket走査を強制するgateはまだなく、本機能だけで全体の不在を保証しない。

## 応答喪失と再開

dispatch counterの確認が失われた呼出しはS3へ進まない。ページ保存の応答が失われた場合、D1には既にcursor/容量が残っている可能性がある。proof lease満了後、新しいnonceで検証して永続cursorから再開する。partのUPSERTと差分triggerにより二重計上しない。失敗時にlease/counter/holdを手動で戻さない。

## 発見済みhandleの中止

`abortMultipartBucketHandle(epoch, handleId, attemptId)`はcallerが保存したUUIDで1回の中止を識別し、`{ abort: { attemptId, outcome, replayed, heldBytes }, audit }`を返す。`outcome`は`confirmed`か`unconfirmed`。前者は指定したkey/IDのR2 abortが応答したという履歴だけを表し、全体閉鎖や現在の不在を表さない。

- 新しい試行には同じsource/current epochのbucket走査と対象part走査の最終ページが必要。未完了のper-upload一覧、同keyで稼働中のapplication upload、未満了のinit/part/complete/cleanup leaseがあればdispatch前に拒否する。tracked handleは対象外。
- fresh proofの下で`started`行を先に確定し、保存応答の確認とproof再検査後だけ、正確なkey/IDへ1回abortする。D1 claimの応答喪失では送信しない。claim自体が保存済みなら64件の予算は消費したままにする。
- 同じattempt IDの再送はfresh proof後に保存結果を読むだけ。`started`は結果不明として返し、R2へ再送しない。別handleでのID再使用も拒否する。receipt保存後の応答喪失はこの経路で回収できる。
- 最大10秒で待機を打ち切り、エラー・NoSuchUpload・timeoutは`unconfirmed`。遅いcallback、失効済みproofやepochはreceiptを書き換えない。終端receiptの更新・削除はDB triggerでも禁止する。
- 再中止には別のattempt UUIDを明示する。1 handleにつき未知応答も含め64件まで。timeout後の外部I/Oが残っている場合もあり、自動retryや予算のリセットはしない。
- 中止後もpartの最大観測bytes、owner physical、予約、quarantine、復旧停止を維持する。空一覧、NoSuchUpload、中止成功、lifecycleの経過だけを理由に精算しない。

[R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)は指定uploadの中止と完成objectの可視性を定義する。[S3 AbortMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html)は進行中partとの競合と再中止・part確認の必要性を記載する。これらから、記録のない遅延create/completeを含む全体閉鎖までは保証できないと判断している。AWSの記述をR2固有の閉鎖保証として扱わない。

## 検証と残作業

`multipart-bucket-admission.test.ts`は8経路の受付拒否・rollback・ACK喪失・確定記録の読取り不能、初回作成、待機後のproof/round変更、固定期限と返却値・容量保持を検査する。`multipart-bucket-control-admission.test.ts`は実ControlDOの同じ32枠を全8経路で埋めて待機させ、owner不在と中止ACK喪失後の再起動・再送禁止を検査する。

`test/integration/multipart-bucket-inventory.test.ts`で実D1/R2/ControlDOとS3応答fixtureを使用する。upload行喪失、同keyの別ID、2種類のpagination、旧ページcycle、100件ページ/part番号10000、並行呼出し、所有者復元、容量増減、integer overflow、counter/page応答喪失、proof失効、source変更、0-byte再開拒否を検証する。実行結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)に記録する。

`test/integration/multipart-bucket-abort.test.ts`の19件は実D1/R2/ControlDOで、中止とhold保持、一覧未完了、稼働upload/lease、claim/receipt応答喪失、proof期限切れ、NoSuchUpload、遅い応答、64回上限、同一ID再送と実ControlDO監査再初期化を検証する。

次は、未知の進行中part/create/completeと完成物の照合、全handleの閉鎖証明を定義し、保留容量の精算と復旧再開へ接続する。どちらの中止receiptも、単独ではこの台帳のholdを削除する根拠にしない。実CloudflareのS3/probe更新頻度・lifecycle・大規模D1負荷も未検証。
