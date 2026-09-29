# 音声の埋め込み表紙

新しいupload・WebDAV PUTのQueue処理から表紙を取り出し、sm256/md768のWebPを生成する。所有者、内部共有、公開リンクのAudio一覧と常駐playerへ配信する。原本の音声MIME・再生URL・音声データは変更しない。

## 抽出範囲

| 音声 | 読み取る表紙 |
| --- | --- |
| MP3 | ID3v2.2 PIC、v2.3/v2.4 APIC |
| FLAC | PICTURE block、Vorbis commentのMETADATA_BLOCK_PICTURE |
| Ogg Opus/Vorbis | METADATA_BLOCK_PICTURE |
| 音声MP4/M4A | ilst/covrのJPEG・PNG data atom |

最初のfront coverを優先し、それがない場合はother画像を使う。埋め込み宣言のMIME・寸法を変換の根拠にせず、画像のバイト列を既存JPEG/PNG/WebP/AVIF inspectorで検査する。URL型の表紙を取得せず、未知のタグをDBへ保存しない。壊れた任意画像を省略しても有効な音声タグを残す。音声コンテナー自体の検査条件は維持する。

音声の通常head≤2MiB、MP3 tail128B、MP4 moov≤4MiB、invocation全体4MiB/128回の読み取り予算を維持する。追加FLAC PICTURE readもこの予算内で行う。表紙自体は20,000,000 bytes以下という変換上限も検査するが、抽出できる大きさは各形式の読み取り予算に制約される。音声原本全体のサイズを20MB以下に制限しない。

形式の根拠は[ID3 APIC](https://id3.org/id3v2.4.0-frames)、[FLAC PICTURE](https://www.rfc-editor.org/rfc/rfc9639.html#section-8.8)、[Vorbis comments](https://wiki.xiph.org/VorbisComment#METADATA_BLOCK_PICTURE)。実際のFFmpeg muxerで表紙を埋めた5形式をfixtureに使う。

## 変換・保存・配信

generatorは`audio-cover-webp-v1`、derivative kindは`cover`。既存Images処理と同じControlDO受付・課金記録・終了receipt・R2 PUT・物理容量予約・pin・回収処理を使う。処理全体の有料試行2回/25秒は通常画像と共有する。変換前に現在の原本/etag/claim/認可を検査し、正確な表紙の長さとSHA-256をsource JSONへ固定する。原本画像用`image-webp-v1`の旧source JSONは変えない。

既知の失敗は記録し、原本と音声タグを保持する。ACK喪失後も成功済み/既知失敗の変換を重複させない。結果不明のnative処理は既存の保留契約に従う。表紙のバイト列や画像タグの説明文をnode_audioへ保存しない。

thumbnail manifest v3に表紙generatorと出力世代を固定する。既存のapp配信endpointが現在の閲覧権限・共有version・原本・公開済み出力・native PUT証拠・pin/回収状態を再検査する。原本差し替えや共有解除後に古いticketで取得できない。新しい公開routeは追加しない。Audioの表紙にlg生成は提供しない。

一覧はreadyの表紙だけに500曲単位でチケットを用意し、画面付近の画像GETを同時4件までに制限する。画像は44px角。音声原本をBlob化せず、表紙だけにobject URLを使う。非表示・再読込・曲変更・閉じる・client終了時に要求を止め、object URLを解放する。変換中・なし・取得失敗でも再生操作を使える。

## 既存音声・コピー先からの要求

現在の音声metadataがある原本は、playerの「表紙を読み込む」から抽出を要求できる。所有者・明示した内部共有・公開リンクに対応し、元uploadの資格情報へ依存しない。所有者間COPYで新しいblobになった原本も、コピー先で引き継いだmetadataと現在の所有権から生成する。原本・曲名の抽出値/override・検索cache・再生位置・node revisionを変更しない。

既存のprivate/public POST thumbへ `{blobId,variant:'sm',share?}` とCSRF・Idempotency-Keyを送る。画像用lgの要求契約は維持する。sm要求は表紙sm/mdの組を生成する。generatorはserverが固定し、クライアント画像を受け取らない。通知IDはblob/sm/audio-cover-webp-v1から固定し、別名・別利用者・並行consumerも同じ有料試行へ集約する。

HTTPは受付と状態照会だけで、生成はQueueへ任せる。pendingは202、ready/absent/unsupported/failedは200。読み取り上限内で選択できる表紙がない場合は、変換0回の結果を保存し、reload後に同じ原本を再走査しない。WAV/WebMは表紙抽出未対応としてunsupportedにする。invocation予算切れ・認可失効・原本変更・未知nativeは「表紙なし」と確定しない。

playerは自動pollせず、pending後の「表紙を確認」で同じ要求keyを使う。完了すると選択中の原本に一致する一覧の1行とplayerだけを更新し、ページ数・音声src・再生時刻を保持する。曲変更・終了・logout後の遅い応答は破棄する。保存した閲覧者が失効した要求は別利用者へ自動付替えせず、既存lgと同じretry/DLQ・保留契約に従う。

## 移行と残件

0075はimage_derivative_start triggerだけを置換し、既知のgeneratorとkindの対応を検査する。通常79table・149公開routeを維持する。適用時はmaintenance、backup/restore未凍結、未終了permit/operation/admission/R2/KDF/Imagesなしを要求する。旧migrationを変更しない。実Cloudflareへの適用は未実施。

既存完了済み音声とCOPY先の表紙は上記の明示要求で生成できる。音声metadata自体が欠けた原本の再抽出・自動一括処理、WAV内ID3・WebM attachmentの表紙抽出は未実装。同一所有者COPYの同じblobは既存の表紙を参照できる。PNG以外の実埋め込み形式や巨大タグ・多種類のencoder、実Cloudflare Images、他OS/browserの検証は追加が必要。実施した試験は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とする。
