# AV1・Opusの情報抽出と動画再生

後続の[MP3・FLAC・WAV](AUDIO_FORMATS.md)と[AAC・Vorbis](AAC_VORBIS.md)も同じOutbox・認可・配信経路へ追加済み。以下はAV1/Opusの解析範囲を記録する。

2026-09-29。通常upload・匿名upload・WebDAV PUTの完了Outboxから、AV1のMP4/WebM（Opus付き／音声なし）とOpusのOgg/WebM/MP4を解析する。Galleryの動画は所有者・内部共有・公開リンクから認可済み原本URLで再生する。原本を再エンコードせず、Imagesにも送らない。

## 解析と保存

コンテナとトラックの構造を読み、AV1構成のprofile・level・tier・8/10/12-bit、Opus構成、寸法・時間を取得する。拡張子とuploadのContent-Typeは判定に使わない。MP4はsample entry・av1C/dOpsと自己完結するdata referenceを検査する。外部URL/URN、暗号化、未対応codec・track構成は公開用MIMEへ昇格させない。mdatは安全な整数の範囲を検査して飛ばし、ファイル全体を読まない。

WebMは最初のClusterまでのInfo/Tracks/Tagsを読み、AV1/OpusのCodecPrivate、track番号・UID・寸法・channelsを検査する。ContentEncodingsを拒否する。OggはOpusHead/OpusTagsを複数pageにまたがって組み立て、CRC・serial・sequence・lacing・continuationを検査する。2MiB以内で終端まで確認できるOggはgranuleとpre-skipから時間を計算する。大きいOggの時間は不明として保持し、全原本を走査して推測しない。

通常のheaderは2MiB・64 GET・4,096構造、MP4は4MiB・128 GET・8,192構造まで。Rangeは32KiB/page・cache4pageで、key/etag/size/range/実bytes・期限を検査する。Queue invocation全体で画像とトラックが同じ読取りcounterを共有し、トラックを含めても4MiB・128 GETを超えない。画像自身の2MiB・64 GET上限と、有料変換2回・25秒の上限は維持する。元の資格情報や認可を失った読取り・native障害・invocation予算不足はretryする。壊れた形式・parser上限は原本を残してメタデータなしで完了する。

曲名・artist・album・track/disc番号だけを保存する。文字列はUTF-8の1KiB以下で、任意タグ、GPS、画像、外部参照を保持しない。`node_media`へ寸法・時間と`track-metadata-v1`、音声単独なら`node_audio`へ抽出タグを保存する。codec構成は正規化した`blobs.mime_sniffed`のcodecs parameterに保持する。既存のschema0072・通常79table・149 routeを使い、migration・依存を追加しない。

元operation/actor/credential・選択した共有・現在node/parent/blob・Outbox claim/token/期限・epochをRange前後と確定batchで照合する。metadata・MIME・Outbox completedは一括確定し、ACK喪失はterminalを確認する。原本・参照・quota会計は変えない。古いblobの音声情報を削除し、同じblobを再抽出する場合のユーザーoverrideは維持する。

## Galleryと原本配信

Galleryは現在blobとimage/track generatorが一致する画像・AV1動画を一覧へ含める。動画にはプレースホルダーを表示し、開いた1件だけを読み込む。cursorの一覧versionを更新し、従来の画像だけのcursorは混在させない。候補上限10,000・200件ページ・共有認可は維持する。

動画の詳細はcodecs付きMIMEを`canPlayType()`で事前確認し、認可済みcontent URLを`video`へ直接渡す。実decode errorでも再生不可とダウンロード導線を表示する。再生・一時停止・シーク・音量はnative controlsを使い、詳細を閉じる／切り替えるとpause・src解除・loadで読取りを止める。原本をfetch→Blob化しない。CSPのmedia-srcはselfと固定content originだけを許可する。

元のcontent URLの`?download=1`は同じ認可・current blob・budget・Range検査の後、Dispositionだけをattachmentにする。variantや他queryとの併用・重複queryを拒否し、配信権限を増やさない。codec付きMIMEはサーバーが生成するAV1/Opusの正規形だけを既存の配信planへ追加する。未対応端末も原本を保存できる。

解析済みAV1/Opus原本の応答CSPは、ブラウザー標準プレーヤーが同じ原本を読めるよう`media-src 'self'`と`sandbox allow-same-origin`を使う。opaque originになると標準プレーヤー自身の原本読取りがCORSで拒否されるため、配信originだけを保持する。`default-src 'none'`・他のsandbox制限・frame-ancestorsを維持し、スクリプト実行や別originのメディア読取りは許可しない。他のファイルのCSPは従来どおりとする。

## 残件

[Audio一覧・常駐player・再生位置APIと自動保存/再開](AUDIO.md)と[MP3・FLAC・WAV](AUDIO_FORMATS.md)は接続済み。[AAC/Vorbis](AAC_VORBIS.md)も接続済み。Bookshelf、既存メディアの再抽出とcopy後の引継ぎは後続。WebMのClusterより後ろだけに置かれたmetadata、複数映像／複数音声・未対応codec、Oggの大きな原本の終端時間推定は現在のparser対象外。対応外の原本を削除せず添付として保持する。Header解析は全bitstreamのデコード検証ではなく、端末の再生成功は実playerで確認する。

仕様参照：[AV1 ISOBMFF](https://aomediacodec.github.io/av1-isobmff/)、[MP4 Opus](https://opus-codec.org/docs/opus_in_isobmff.html)、[Matroska codec mappings](https://www.matroska.org/technical/codec_specs.html)、[Matroska elements](https://www.matroska.org/technical/elements.html)、[Ogg Opus RFC 7845](https://www.rfc-editor.org/rfc/rfc7845.html)、[Ogg RFC 3533](https://www.rfc-editor.org/rfc/rfc3533.html)。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。実Cloudflare・他browser/OSの保証は別途必要。
