# upload行が失われたmultipartの観測と容量保留

更新: 2026-09-24。migration `0027`と`jobs/multipartBucketInventory.ts`で、D1のupload行がない未完了multipartも保存先の`u/`全体から発見し、各partの観測済み容量を保留する。回収完了・全体不在の証明と容量精算は未実装。実S3試験・remote migration・deployは行っていない。

## 呼出しと範囲

停止中のControlDO内部RPCを使う。HTTP、管理UI、Cronへの接続はまだない。

```ts
await control.inventoryMultipartBucket(epoch, 20);
await control.observeMultipartBucketParts(epoch, handleId, 20);
```

最初のRPCは`{ inventory: { examined, completed, handles }, audit }`、次は`{ observation: { observed, heldBytes, completed }, audit }`を返す。`handles`はD1のUUIDと`tracked`/`quarantined`の組で、R2 upload IDは返さない。`completed`はその一覧走査の最終ページに達したことだけを表す。handleの閉鎖やbytesの不存在を意味しない。

各呼出しはmaintenance・GC pause・current epochを要求し、[fresh nonceによるBLOBS/S3対応検証](MULTIPART_INVENTORY.md)を毎回行う。既存の60秒probe leaseで直列化し、counter更新の確認後だけS3へdispatchする。保存とcursor更新は同じproof/scan snapshot fence付きD1 batchで確定する。ControlDOは処理の前後に復旧監査を初期化する。

1回に1ページ、既定20・最大100件。既存S3 clientのXML・echo・marker検査、1 MiB・10秒上限、redirect/retry禁止を使用する。probe検証のGETはこの一覧GETとは別。設定と資格情報は[MULTIPART_INVENTORY](MULTIPART_INVENTORY.md)と同じ。

## 永続台帳

| table | 保存する情報 |
|---|---|
| `multipart_bucket_scan` | source/epoch/round、KeyMarkerとUploadIdMarker、ページ数、完了時刻、累積dispatch counter |
| `multipart_bucket_handles` | source/key/upload IDごとの不変identity、Initiated、所有者、隔離状態、観測round、保留容量、part cursor/round/counter |
| `multipart_bucket_parts` | handle/part番号ごとの最大観測bytes、直近のbytes/ETag/更新日時/round |

一覧は既知handleも記録する。D1に**keyとR2 upload IDが両方一致するupload**がある場合だけ`tracked`にする。同じkeyの別IDは`quarantined`。一度隔離したhandleは、遅れて元のIDがD1へ反映されても自動でtrackedへ戻さない。trackedは今回のpart観測対象外であり、既存uploadの会計を使用する。

source・epoch変更や走査完了後の次呼出しは新roundを先頭から始める。古いsourceのhandle/bytesは残し、別sourceからpartを観測しない。同じroundで前ページのhandleが再登場すればページ全体を拒否する。異なるInitiatedへの置換も拒否する。source変更後の重複観測は保守的な過大保留になり得るため、将来の精算で証明に基づく照合が必要。

## 容量と再利用の制約

各partは`max(以前のbytes, 今回のbytes)`を保持し、handleの合計とownerの`physical_bytes`へ差分だけ加算する。owner ledger監査もこの合計を含む。現在の正確なstorage総量ではなく、観測履歴に基づく保守的な保留である。未観測のpartや遅延送信があり得るため、全量を観測した保証にはしない。

- partの縮小・消失、空一覧、404/NoSuchUpload、応答喪失では容量を減らさない。
- partがまだ未観測なら`part_round_id`はNULL、`held_bytes=0`。未完了容量がゼロという証明ではない。
- `u/{owner}/b/{blob}`だけを所有者へ対応させる。user行が失われていれば未帰属で保持し、後日userが復元された時に一度だけ計上する。不正形のkeyは未帰属のまま隔離する。
- handle/partの削除、容量減算、identity変更、隔離解除をDB triggerで拒否する。整数上限を超えるページは全体rollbackする。
- 隔離keyでのblob新規作成・stagingからのcommit、derivative/archive/target manifestの新規登録・key変更を拒否する。
- namespace公開、R2 abort/delete、reservation解除は行わない。完成済みobjectの観測・回収は既存のobject inventory/GCが担当する。

復旧の最終D1 fenceは未完了scan、旧epoch/source、隔離handle、元のuploadとの対応が失われたtracked handleを拒否する。**0 bytesの隔離handleも再開を止める**。走査を開始していないDBに全bucket走査を強制するgateはまだなく、本機能だけで全体の不在を保証しない。

## 応答喪失と再開

dispatch counterの確認が失われた呼出しはS3へ進まない。ページ保存の応答が失われた場合、D1には既にcursor/容量が残っている可能性がある。proof lease満了後、新しいnonceで検証して永続cursorから再開する。partのUPSERTと差分triggerにより二重計上しない。失敗時にlease/counter/holdを手動で戻さない。

## 検証と残作業

`test/integration/multipart-bucket-inventory.test.ts`で実D1/R2/ControlDOとS3応答fixtureを使用する。upload行喪失、同keyの別ID、2種類のpagination、旧ページcycle、100件ページ/part番号10000、並行呼出し、所有者復元、容量増減、integer overflow、counter/page応答喪失、proof失効、source変更、0-byte再開拒否を検証する。実行結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)に記録する。

次は、記録を失ったhandleの中止・進行中part/create/completeとの競合、完成物との照合、全handleの閉鎖証明を定義し、保留容量の精算と復旧再開へ接続する。既存uploadの[未知ID中止](MULTIPART_INVENTORY.md)のreceiptだけで、この台帳のholdを削除してはいけない。実CloudflareのS3/probe更新頻度・lifecycle・大規模D1負荷も未検証。
