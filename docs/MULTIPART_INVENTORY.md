# 未完了multipartのS3診断

`r2/s3Inventory.ts`、`r2/s3InventoryPages.ts`、`r2/s3Xml.ts`は、Workers bindingでは列挙できない未完了multipartをS3 APIから読み取る。`jobs/multipartInventory.ts`と`ControlDO.inspectIncompleteMultipart`はmaintenance中の診断へ接続する。migration `0022`と`jobs/multipartInventoryRepair.ts`は、D1にupload行が残っている未知IDを永続走査し、実BLOBS bindingから中止する。migration `0023`と`jobs/r2BindingVerification.ts`は、fresh nonceによるBLOBS/S3対応検証を追加する。migration `0027`でupload行喪失時の[全bucket走査・part容量保留](MULTIPART_BUCKET_INVENTORY.md)も追加した。完全な不在証明・予約解放は未接続。

## サーバー設定

| 変数 | 内容 |
|---|---|
| `R2_INVENTORY_ACCOUNT_ID` | 32桁の小文字hex account ID |
| `R2_INVENTORY_BUCKET` | 対象bucket名。3〜63字、小文字英数字とハイフン |
| `R2_INVENTORY_JURISDICTION` | `default`（省略時）、`eu`、`fedramp`、`us` |
| `R2_INVENTORY_ACCESS_KEY_ID` | S3 Access Key ID。secret bindingで供給する |
| `R2_INVENTORY_SECRET_ACCESS_KEY` | S3 Secret Access Key。secret bindingで供給する |

未設定・不正設定なら`s3_inventory_unconfigured`で停止する。上記の実値はまだ設定していない。通常のローカル開発・既存upload/cleanupはこれらの変数を必須にしない。クライアントHTTPやRPC引数から接続先・鍵を受け取らず、固定CloudflareドメインのHTTPS URLを組み立てる。実環境の権限・BLOBS bindingとの対応・lifecycle・API互換性はstaging検証が必要。

署名は固定依存`aws4fetch@1.0.20`の`sign()`、service=`s3`、region=`auto`で行い、明示的なfetchを1回だけ実行する。自動retry、presigned URL、redirect追従は使用しない。上流エラー本文、署名付きrequest、資格情報をログやRPC結果へ出さない。エラーは固定codeだけに変換する。

## 1ページの境界

- multipart一覧: `ListMultipartUploads`、prefixは`u/`以下、既定20件・最大100件。`encoding-type=url`を要求し、Key/Prefix/KeyMarkerだけを1回URL decodeする。UploadIdはopaque文字列のまま扱う。
- 継続にはKeyMarkerとUploadIdMarkerの両方を使う。同keyの別IDを失わず、重複tuple・UTF-8 key順の逆行・同keyのInitiated逆行・同じmarker再出現を拒否する。truncated時のnext markerは末尾tupleと一致しなければならない。
- part一覧: `ListParts`、既定20件・最大100件。key/UploadId/marker/maxのechoを照合し、part番号1〜10,000の昇順、safe integerの非負bytes、ETag、日時を検証する。URL正規化で別keyになる`.`/`..` path segmentは拒否する。
- 応答は最大1 MiB、XMLは深さ16・10,000 elements・32 namespace bindings、1rootとS3 namespaceを要求する。DTD・独自entity・CDATA・PI・未知field・scalar重複・非正規bool/整数・壊れたUTF-8を拒否し、部分結果を返さない。
- fetch・body読取り・署名を含むtransport deadlineは10秒。timeout/超過時はabort/cancelする。HTTP 404/NoSuchUpload、429、5xx、redirectを空一覧へ変換しない。
- 1回の診断は1 GETだけ。全件scanを自動で回すループはない。複数ページ全体のsnapshot一貫性や長いcursor cycleの検出は、後続の永続scanで扱う。

## lifecycle観測

`GetBucketLifecycleConfiguration`で`AbortIncompleteMultipartUpload`を読む。Enabledで`u/`全体を覆うDaysAfterInitiation=7のprefix/空Filter/legacy Prefixがあり、それより早い中止を行う重複prefixや解釈不能な有効selectorがない場合だけ`sevenDayCoverage=true`を返す。disabled、部分owner prefix、Tag/And/size filter、selectorなし、7日以外の設定は単独では全体coverageとしない。

これは取得した設定の診断であり、実際の中止完了や実BLOBS bucketとの一致を証明しない。404も「デフォルト7日」と推測しない。

## ControlDOとの接続

内部RPC `inspectIncompleteMultipart(expectedEpoch, query)` は次のqueryを受ける。

```ts
{ kind: "uploads", prefix?: "u/…", limit?: number, marker?: { key, uploadId } }
{ kind: "parts", key, uploadId, limit?: number, marker?: number }
{ kind: "lifecycle" }
```

ControlDOは前後でquiesceと監査再初期化を行う。S3取得前後でD1のcurrent epoch・maintenance・gc_pausedを再確認し、途中で制御状態が変わった応答を採用しない。公開HTTP routeやCronへは接続していない。

返却値の`observation`には非秘密のaccount/bucket/jurisdictionと、`bindingVerified:false`、`closureProven:false`を明示する。既存multipart ID、part receipt、namespace、予約会計、閉鎖markerを更新しない。空一覧でも予約を維持し、admissionを再開しない。

## 発見したIDの中止修復

内部RPC `ControlDO.repairUnidentifiedMultipartUploads(expectedEpoch, limit=5)`は、S3設定からclientを作り、前後で停止・監査再初期化を行う。service自体もmaintenanceとGC pauseを必須とし、毎回`withVerifiedR2Inventory`で実BLOBS/S3の対応を新しいnonceで検証する。公開HTTP/Cronへはまだ接続しない。

検証に成功した同じcallbackからのみ回収を実行する。claim/永久停止/scan登録、round再初期化、各dispatch counter、page/handle/abort receipt、HEADのphysical観測、cleanup lease解放と診断更新は、current proof fenceと同一D1 batchで確定する。誤bucket・古いnonce・確認不能なprobeでは対象uploadのclaim・一覧・abortを開始しない。epoch/pause/lease/検証世代が変われば保存と後続dispatchを拒否する。pageの保存応答を失いreadbackで確認できても、次のdispatchは再度current proofを必要とする。完了済みpageからの再開にも新しいnonceが必要。

probeの60秒leaseで同時検証/修復を直列化する。期限切れ時はRPC全体を成功扱いにせず、保存済みのpage/receiptと未解決uploadのlease・容量予約を保持する。次回はfresh検証をやり直す。`repair.r2Calls`は従来どおりupload回収の呼出し数で、先行するprobeのBLOBS GET/PUT/S3 GETの3回は`r2_binding_probe.calls`へ別計上する。回収の20秒予算は検証後から計測するが、probeの60秒期限を延長しない。migration・依存追加なし。

`repairUnidentifiedMultipartUploads`は最大20 upload、1 uploadあたり1 S3ページ/20件、既定10・最大20 handleのabort、20秒既定/25秒最大の実行予算を使う。S3 transportは既存の10秒上限。R2 bindingの実行結果が遅れた場合も60秒cleanup leaseとcurrent epoch/tokenで保存・後続dispatchを拒否する。

- `multipart_inventory_scans`はupload IDをPKにsource/epoch/round、KeyMarker/UploadIdMarker、pages、完了時刻、次回走査時刻を保存する。claimと永久停止・blob orphan化・scan登録は同じD1 batch。source/epoch変更では新roundへ戻す。
- `multipart_inventory_handles`はupload IDとR2 upload IDの組ごとに最初のsource、Initiated、観測時刻、round、abort試行数・時刻、確認済み中止receiptを保存する。最初のIDだけをuploads.r2_upload_idへ書き戻さない。
- init/part/completeの有効lease、公開済みoperation、ref/pin、GC candidateを除外し、既存cleanupと同じclaim/fenceで競合を抑える。正常稼働中の既知IDはこの走査の対象外。
- sourceから取得するのはprefix一覧なので、実際に中止するのはD1のimmutable keyと完全一致するIDだけ。隣接keyは触らない。同roundの重複handleをDBでも拒否し、長いcursor循環を進捗として採用しない。
- keyの全ページを保存してからabortを始める。途中でmarkerのhandleを中止してS3ページングを壊さない。未処理handleは次の呼出しで一覧を取り直さず続行する。
- 各R2/S3呼出しの前にcleanup counterとcurrent fenceを確定する。counterの応答が不明ならその呼出しをdispatchしない。scan/page/abort receipt保存の応答喪失は正確なround/token/tupleまたは不変receiptで照合する。
- 実BLOBS bindingのabort成功だけを`state='aborted'`にする。NoSuchUpload・404・timeout・応答喪失ではobservedのまま保持する。確認済み中止receiptを再送で消したり、成功済みhandleを無用に再中止しない。
- 対応検証に成功した後、S3一覧取得前と処理後にHEADし、完成objectがあればmetadataの不一致でも実physical bytesを計上する。一覧取得の障害で完成物の容量計上を止めない。対応検証自体の失敗・失効ではHEAD/保存も拒否し、容量予約を保持して再検証を待つ。objectのdelete、namespaceの公開、予約精算は行わない。
- 途中失敗ではclaim leaseを保持し、成功ページはカーソル・観測・全IDを原子的に保存する。走査と中止が一巡したら1時間後に再走査し、予約は保持する。

scan登録後は、後から元のR2 IDが判明しても通常cleanupへ戻さず、既存IDを追加handleとして中止する。D1 triggerは予約のreserved以外への遷移、cleanup完了flag、閉鎖marker、scan/handle削除を拒否する。復旧最終fenceもscanの存在を拒否する。これらの解除には、検証済み閉鎖証明を導入するforward migrationが必要。

## BLOBSとS3の対応検証

内部RPC `ControlDO.verifyInventoryBinding(expectedEpoch)`は、停止・GC pause中に一度限りの対応検証を実行し、前後で復旧監査を初期化する。設定済みS3接続先以外のURL・資格情報・確認値をRPCから受け取らない。既存の`inspectIncompleteMultipart`は読み取り専用のままで、引き続き`bindingVerified:false`を返す。

`withVerifiedR2Inventory`は、実BLOBSへ新しい256-bit乱数を64文字のhexとして保存し、認証済みS3 GETで同じ内容を読み取る。古い成功記録や、別bucketへコピーされた以前の確認値を再利用しない。

- 固定keyは`system/r2-binding-probe-v1`。ユーザーobjectと分離し、blob/derivative/archive/target manifestへの同key登録・更新をD1 triggerで拒否する。migration時に既存catalogueが衝突していれば適用を拒否する。
- objectは最大1個・64 bytes。D1の`r2_binding_probe.allocated_bytes=64`で、PUT結果不明のときもsystem用の容量を確保する。userのused/reserved/physical quotaには混ぜない。実運用の総容量集計ではこのsystem枠を別途加算する。
- current objectをBLOBS GETで読み、size・protocol metadata・64文字hexを検査する。既存の未認識objectは上書きしない。初回は`If-None-Match: *`、更新は取得したETagの`etagMatches`を付けてPUTを1回だけ行う。条件不成立のnullは成功扱いにしない。
- keyは通常処理で削除しない。古い初回createが遅れて到着しても既存objectにより拒否され、旧ETagを条件にした遅延更新も新世代を上書きできない。外部からの削除・置換は監査で検出する。
- D1にはepoch、世代、source、nonce、状態、期待ETag、R2実観測tuple、検証時刻、60秒lease、呼出しcounterを保存する。BLOBS GET/PUT/S3 GETの各dispatch前にcounterの確定応答を要求する。D1やR2の応答が不明なら後続dispatch・proof使用を停止し、lease期限後の新nonce・条件付き更新で再検証する。PUTの無条件再送は行わない。
- S3 GETは固定keyだけを許し、応答上限64 bytes・既存の10秒transport deadlineを使う。404・403・redirect・壊れたbodyを不在証明に変換しない。
- 検証後の内部callbackは同じbucket/clientとcurrent proof fenceを受け取る。権限を使うD1変更は`verified.fence()`と同一batchで実行する。scope終了、epoch/pause変更、lease失効、世代交代後は保存したSQL fenceも失敗する。最終保存前にもfenceを再確認する。
- RPCの`bindingVerified:true`はその呼出し時点の診断結果であり、後のcleanupに渡す許可証ではない。nonce・署名・資格情報を返さない。未知ID回収serviceは内部helperで毎回新しい検証を取得する。
- 復旧R2監査はsettled objectのsize/ETag/version/uploadedを照合し、最初のページでHEADして消失も検出する。未解決phase/leaseは最終fenceで拒否する。成功済み検証の存在だけではmultipart scanの予約holdを解除しない。

[Workers APIの条件付きPUT](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)と[R2の整合性モデル](https://developers.cloudflare.com/r2/reference/consistency/)を根拠にする。ローカルworkerdで条件付きPUT・競合・遅延初回create/更新を実行して検証した。S3応答はfixtureであり、実R2 S3でのbinding対応・権限・lifecycle検証はstagingに残る。

## 次の修復段階

1. BLOBS/S3対応検証は未知IDの走査・中止へ接続済み。次は全体閉鎖証明を定義して同じcurrent D1 fenceへ接続する。既存scan/pageは閉鎖証明へ昇格させない。実S3でのstaging試験も必要。
2. D1のupload行自体が失われたhandleの全`u/` inventory・part最大観測容量の保留は接続済み（[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md)）。次は中止・全体閉鎖・精算。既存uploadの複数ID走査・中止は接続済み。
3. 発見IDの中止receiptに加え、全handleの閉鎖と不在証明を確立し、予約精算・GCへ接続する。
4. lifecycle経過だけで閉鎖とせず、未知create/completeの遅延完了も含めた不在証明を定義・検証する。

DB snapshotにID/partがないことは、R2に未完了bytesがない証拠にならない。未知IDを最初の1件だけuploadsへ結びつけると、別handleを残して予約を解放するため禁止する。

2026-09-24に[Cloudflare Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)と[AWS AbortMultipartUpload](https://docs.aws.amazon.com/AmazonS3/latest/API/API_AbortMultipartUpload.html)を再確認した。AWSは中止と進行中partの競合、および容量回収確認のための追加確認を説明している。これをR2の未知create/completeまで閉鎖済みとする保証には使わない。今回の対応検証の接続でも予約holdと復旧最終fenceは維持する。

## 参照と検証

[Cloudflare S3互換API](https://developers.cloudflare.com/r2/api/s3/api/)、[aws4fetch例](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/)、[jurisdiction endpoint](https://developers.cloudflare.com/r2/reference/data-location/)、[AWS ListMultipartUploads](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListMultipartUploads.html)、[ListParts](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html)、[GetBucketLifecycleConfiguration](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetBucketLifecycleConfiguration.html)を確認した。

NodeでXML/署名/timeout/上限・設定の失敗境界、workerdで実WebCrypto・D1 fence・ControlDO監査再初期化・予約保持、実multipartの中止、複数ID、page/claim/receiptの応答喪失、遅延ID、epoch/token/pin/lease、完成物のphysical会計を試験する。S3応答はfixtureであり、実R2 S3サービスへの接続試験は未実施。
