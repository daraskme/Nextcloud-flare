# ZIPダウンロード

2026-09-29時点で、所有者・内部共有の受信者・公開リンクからのZIP保存を、APIと画面へ接続しています。閲覧権限のあるroot/folderを対象に、日本語名と空フォルダーを含む固定snapshotをSTORE形式で配信します。upload-onlyリンクには提供しません。

## 実装済み

- `storeZip.ts`: 同じfflate STORE serializerでサイズ測定と配信を行います。CRC、descriptor、UTF-8名、中央ディレクトリを含み、空archiveは22 bytesです。空folderには末尾`/`とDOS directory属性を付け、入力streamを開きません。fileとdirectoryの衝突、NFC重複、危険なpath、不正なUTF-16、1,000 entries超過、ZIP32上限超過を拒否します。queue上限は1 MiB、入力は1件ずつ開き、cancel時はreaderを停止します。
- `zipSnapshot.ts`: 中央認可を通したroot/folderから、上限と超過判定用の1件を含むindexed subtree traversalで内容を固定します。パスはD1のparent/nameから再構成します。privateの他ownerは明示的なinternal shareを必要とし、publicはread可能なlink shareのroot内に制限します。upload-onlyは拒否します。
- `zipManifest.ts`: v2 manifestへroot、revision、tree generation、並び順を固定したentry、実blob target、serializer version、正確な出力bytesを保存します。読取り時も同じserializerでサイズを再計算し、余分なfield、targetや順序の不一致を拒否します。従来のv1 manifestの形式は維持します。
- `BudgetDO`: v2 manifestはZIP purposeだけで受け付け、ヘッダー等を含む正確な出力サイズの3倍を共通予算へ追加します。archive allowanceのidentityはpath/kind/blob/size/serializerから作ります。target-set ID、node ID、revisionや無関係なtree generationが変わっても、同一archiveへの再発行で残量は増えません。原本とZIPは同じ予算の使用量・並列数・request窓を共有します。
- `zipPins.ts`: manifest保存前に、対象blobを重複除去して同じD1 batchで保持します。snapshot、現在の権限、期限、物理台帳を再検査し、unknown commitでも保持を先に返しません。最大10分の絶対期限までは、1回の完了や取消しでは他のreaderの保持を外しません。呼出し側は、その期限以下のleaseで全streamを停止する必要があります。
- 定期処理は期限切れZIP pinを上限付きで解放します。system admission、現在epoch、maintenance解除、正確なpin/blob/期限を同じbatchで検査するため、停止中に保持を外しません。owner無効化後も期限切れのDB会計を精算できます。migration0067は専用の部分索引だけを追加し、通常76tableを維持します。

## 発行・取得と画面

- privateは`POST /api/v1/nodes/:nodeId/zip`と`GET /api/v1/zips/:zipId`、publicは`/api/v1/public/shares/:shareId`配下の同じ経路です。発行は現在のCSRFと、publicでは元の`Share-Session`を必要とします。internal受信者は選択したshare ID/versionを発行bodyへ固定します。
- `zipTicket.ts`はsnapshotとpin取得後にtracked R2 manifestを保存・読戻しし、共通`publishContentTicket`で現在の認可・snapshot・pin・budgetを同じ公開batchで検査します。共通のD1 content sessionへサーバー内で交換します。応答は`{id,size,expiresAt,url}`だけで、署名ticketや原本/R2 IDを返しません。期限は最大10分かつ元credential/share以下です。
- URL内のZIP IDは元credential用のselectorです。別のAccess credentialや匿名Cookieでは取得できません。`zipRead.ts`は毎GETで現在のcredential/share/version/epoch/session、manifest hash、全node/blob、pinを再検査し、budget確保後にも検査します。途中からsnapshotが変わっても、認可済みの1応答は保持した元のbytesで期限内に終了できます。次のGETは変更を再検査します。
- `streamLeasedContent`がlease・request abort・絶対期限をSTORE serializerと逐次R2 readerへ適用します。R2のsize/etag不一致や読取り失敗はbody errorにし、送信開始後の切断・失敗は予約した全bytesを課金します。完了・取消し・発行失敗でも他のreaderに必要なpinを早期解放しません。
- 安全なattachment filename、private/no-store、nosniff、no-referrer、sandbox CSPを付けます。Rangeは非対応で416、本文なし、bytes課金0・request課金1です。HEAD経路は提供しません。
- Filesの現在folder/操作メニュー、Sharedの現在folder/各folder、公開リンクの現在folder/各folderに「ZIPで保存」を表示します。popupをユーザー操作時に開き、検証済みの同じappの取得URLへ移動します。archive全体をbrowserでbufferしません。ログアウト中の遅い応答・任意URLを拒否し、発行失敗は自動再送せずpopupを閉じます。1,000項目制限等は画面に説明します。

## 制約と残件

1,000 entries（folderも1項目）、出力4,294,967,295 bytes以下、最大10分の期限を適用します。大規模ZIPの実Cloudflare環境でのCPU/転送時間・R2 chunk挙動、実ブラウザー/OSの組合せは未検証です。共有のthumb/page/trackとmedia viewerは別工程です。

remote migration/deployは実施していません。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。
