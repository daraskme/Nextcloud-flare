# 画像メタデータの抽出

2026-09-29。Galleryの前提となる画像メタデータを、通常uploadとWebDAV PUTの完了Outboxへ接続する。元ファイルを再エンコードせず、既存のnode_mediaとblobs.mime_sniffedへ保存する。schema0067・通常76table・147 route、依存追加なし。

## 検出と上限

`media/images/inspect.ts`は拡張子やclient MIMEを受け取らず、JPEG・PNG・WebP・AVIFのheaderを解析する。AVIFは主画像のpitm/iinf/ipmaを照合し、補助画像のispeを誤って使わない。AV1構成、単段gridの参照、irot/imirも確認する。静止画・10-bit・sequenceは実エンコードfixtureを持つ。画像データの全decodeやブラウザーの対応保証ではない。

読み取りは32KiB/page・cache4page、1画像/1Queue invocationにつき最大2MiB・64 GET、最大4,096構造に制限する。PNG IDATやAVIF mdatはoffsetで飛ばす。R2 Rangeのkey/etag/元size/offset/lengthとbodyの実bytesを照合する。1回のQueue内で複数配信を処理してもnative上限を増やさない。解析できない形式・壊れたheader・parser上限はメタデータなしで終了し、元ファイルの保存には影響しない。native障害・現在認可の喪失・期限・invocation予算不足は再試行を返す。

EXIFは最大64KiB、IFDごと256entry、文字列1KiBまで。IFD0とExif IFDからorientation、camera make/model、DateTimeOriginalとOffsetTimeOriginalだけを取り出す。GPS IFD、MakerNote、任意EXIF、XMP、埋込み画像、次IFDを追わず保存しない。撮影時刻は明示UTC offsetと暦の整合があるときだけUTCミリ秒へ変換し、タイムゾーンを推測しない。壊れたEXIFは画像寸法と分離して破棄する。

## 認可と確定

`jobs/imageMetadata.ts`は元upload.complete/dav.putのblob stepと現在node/blob/元parentを一致させる。別の上書きや共有外への移動後に、その新しい内容を古いイベントから読み取らない。元actor/credential/current grant、Outbox claim/token/期限、epoch/maintenance、D1/R2保存記録を各Rangeの前後と確定batchで確認する。遅いR2応答は期限後にbodyを取り消す。

匿名の受け取り専用uploadは、通常のフォルダー作成権限を持たない。Outboxも元のcompleted upload、completion operation、credential/share/version/epoch、parent、予約の履歴を照合した上でupload用途の作成認可を使う。一般のnode.createへ拡張せず、元fileのread権限も与えない。この照合はproducer/consumerの受付と確定に共通する。

メタデータ・判別済みMIME・Outbox completedは同じD1 transactionで確定する。古いblobのメタデータを現行結果と混在させず、重複配信はcompletedを照会して終了する。応答喪失もD1のterminalを読み戻す。原本bytes・quota/ref・既存content ticket/budgetは変更しない。画像判別後は既存原本配信が判別済みimage MIMEを使う。

WebDAV PUTも利用者申告のContent-Typeをinline mediaの証拠にしない。新しいPUTはtext/plain以外をapplication/octet-streamとして確定し、解析した画像だけをimage MIMEへ更新する。動画/音声/PDFの抽出が未接続の間は原本添付として保存・配信する。既存のblobの再判別とMIME移行は後続の既存データ再抽出へ含める。

## 次の接続

- [Images変換の内部実行部](IMAGE_TRANSFORMS.md)でsm256/md768/lg1600を生成・検査する。generation resultの費用/claim/physical会計・R2終了記録と[Queue自動生成](IMAGE_QUEUE.md)は接続済み。配信、Gallery API・画面は未実装。
- 既存ファイルの再抽出、COW/cross-owner copy・move後のメタデータ引継ぎと再抽出を接続する。今回のOutbox対象は新しいupload/PUTの原本書込み。
- AVIFのExif item、複数段の派生画像、動画/音声のtrack・tag・duration抽出、Bookshelf/AudioとAV1/Opusの実再生は後続。
- Imagesへの入力は別途20MB・12,000px・40MP・frame1の制限を適用する。原本とサムネイルの対応可否を混同せず、AVIF変換不可時も原本閲覧を接続する。

検証の正本は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。仕様参照: [AVIF](https://aomediacodec.github.io/av1-avif/)、[PNG](https://www.w3.org/TR/png-3/)、[WebP](https://developers.google.com/speed/webp/docs/riff_container)、[CIPA Exif](https://www.cipa.jp/e/std/std-sec.html)。
