# 未完了multipartのS3診断

`r2/s3Inventory.ts`、`r2/s3InventoryPages.ts`、`r2/s3Xml.ts`は、Workers bindingでは列挙できない未完了multipartをS3 APIから読み取る。`jobs/multipartInventory.ts`と`ControlDO.inspectIncompleteMultipart`はmaintenance中の診断へ接続する。現在は読み取りまでで、未知IDの永続隔離・abort修復・予約解放へは接続していない。

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

## 次の修復段階

1. S3対象bucketと実BLOBS bindingの対応を実証する。設定値や呼出者のbooleanだけで一致扱いにしない。
2. 永続cursor/lease/epoch付きで複数handleを隔離し、同keyの追加ID、応答喪失、復元で消えたpart receiptを扱う。
3. permanent stopとdispatch drainを確認したhandleだけを実BLOBS bindingからabortし、全handleの閉鎖と完成objectのHEADを確認して既存会計へ接続する。
4. lifecycle経過だけで閉鎖とせず、未知create/completeの遅延完了も含めた不在証明を定義・検証する。

DB snapshotにID/partがないことは、R2に未完了bytesがない証拠にならない。未知IDを最初の1件だけuploadsへ結びつけると、別handleを残して予約を解放するため禁止する。

## 参照と検証

[Cloudflare S3互換API](https://developers.cloudflare.com/r2/api/s3/api/)、[aws4fetch例](https://developers.cloudflare.com/r2/examples/aws/aws4fetch/)、[jurisdiction endpoint](https://developers.cloudflare.com/r2/reference/data-location/)、[AWS ListMultipartUploads](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListMultipartUploads.html)、[ListParts](https://docs.aws.amazon.com/AmazonS3/latest/API/API_ListParts.html)、[GetBucketLifecycleConfiguration](https://docs.aws.amazon.com/AmazonS3/latest/API/API_GetBucketLifecycleConfiguration.html)を確認した。

NodeでXML/署名/timeout/上限・設定の失敗境界、workerdで実WebCrypto・D1 fence・ControlDO監査再初期化・予約保持を試験する。S3応答はfixtureであり、実R2 S3サービスへの接続試験は未実施。
