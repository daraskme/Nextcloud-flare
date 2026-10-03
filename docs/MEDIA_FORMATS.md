# エンコード済みメディアの対応契約

2026-09-22 の依頼を反映。画像 AVIF、動画 AV1、音声 Opus を必須の対応対象にする。
ユーザーが事前にエンコードした原本を保存・配信し、サーバー再エンコードを受付や原本再生の条件にしない。

| 対象 | コンテナ / 拡張子 | 配信 / 再生判定 |
|---|---|---|
| AVIF | `.avif` / `.avifs`、BMFF の `avif` / `avis` brand | `image/avif`。`<img>` の load/error で実デコードを判定 |
| AV1 動画 | MP4 / WebM | `video/mp4` / `video/webm`。抽出済み profile/level/tier/bit depth から `av01.*` を生成 |
| Opus 音声 | Ogg (`.opus` / `.ogg` / `.oga`) / WebM / MP4 (`.mp4` / `.m4a`) | `audio/ogg` / `audio/webm` は `codecs="opus"`、MP4 は `codecs="Opus"` |
| AV1 + Opus | MP4 / WebM の映像・音声 track | 両方の codec を列挙。音声無しの AV1 も対象 |

拡張子、upload の Content-Type、client の申告 codec だけで inline を許可しない。
`media/sniff.ts` は最大64KiBの prefix、最大4KiBの構造 header からコンテナ候補を調べる。MP4/WebM/Ogg の判定だけでは codec を確定しない。
track の bounded parser が確定した値から `shared/media.ts` の descriptor/MIME を作る。8-bit 固定にせず10/12-bit、実 profile/level を保つ。
ブラウザーの `canPlayType()` は事前判定であり、`maybe`/`probably` も再生成功を保証しない。実 `<audio>`/`<video>` の error 時は再生不可とダウンロード導線を表示する。
AVIF に media element の `canPlayType()` を流用しない。

原本は既存の content-session / purpose / current blob / Range / no-store 契約で直接配信する。
大きな画像・音声・動画を fetch→全体 buffer→blob URL に変換しない。動画の seek / Opus の seek は単一 Range で検証する。

## private resume state

Audio/Video の再生位置と EPUB の読書位置は D1 の user/node/current-blob 単位で保持する。read/write は private Access user のみを対象にし、毎回 live ancestry、current blob、owner または有効な internal share、credential、epoch、maintenance を再検証する。public share へ状態 API を公開しない。

Audio/Video は抽出済みの current metadata の duration に位置を clamp し、browser が有限 duration を報告するまで自動 seek しない。約5秒の debounce と pause/end/selection change の flush を使い、blob replacement 後の古い応答や書込みは採用しない。

EPUB は current blob の bounded index に対する `{spineIndex, progress}` のみを保持する。`spineIndex` は current `page_count` 未満、`progress` は 0–10000 とし、publication の path、markup、識別子を状態として信用しない。表示は既存の text extraction、escape、sandbox、CSP を維持する。

Cloudflare Images による AVIF 入力は Enterprise 条件があるため、サムネイルの可否を原本の対応可否と混同しない。
変換 unavailable/failed/pending の場合、detail は認可済み原本、grid は placeholder とし、大量の原本を grid で一括読込みしない。
server derivative は既存の WebP / metadata 除去 / budget / claim fence に従う。client thumbnail 受付は追加しない。

## 実装と残る確認

- 実装済み: bounded container sniff、AV1/Opus の MIME/codec string、native probe adapter、AVIF 原本/derivative 選択。単体20件。
- 接続済み: private content route、track/metadata parser、Gallery/lightbox、Audio/Video player、Bookshelf/EPUB reader、public Gallery/Audio/Bookshelf/Video UIとthumbnail/audio/video ticket delivery、public EPUB metadata/page/entry、public/private ZIP、media reading/playback resume state。private Galleryはthumb/原本ticketを画面切替・close時に取消す。
- 2026-10-03: 共通outboxからOpus音声専用のOgg/WebM/MP4解析を接続した。Oggは先頭識別pageのCRCとOpusHead、WebMはCodecPrivate、MP4はdOpsをboundedに検査する。MP3/Opus/AV1の解析成功時にcurrent projectionとblob MIMEを確定し、ブラウザーupload時のoctet-streamがAudio一覧やtrack配信を妨げる問題を修正した。専用管理画面もnative audio/video previewを使う。
- 必須 fixture: AVIF 静止画/sequence、AV1 MP4/WebM（音声なし/Opus付き、8/10-bit）、Opus Ogg/WebM/MP4、偽装拡張子/truncated header、seek/Range、再生不可表示、AVIF derivative unavailable 時の原本表示。
- AVIF静止画はboundedなprimary AV1 item・extent・property・OBUの検査から寸法を取得する。ImagesのAVIF入力対応に依存せず、検証済みMIMEと画像metadataを同じ認可・current blob・outbox fence内で保存する。thumbnail生成に失敗しても、認可された原本の詳細表示を利用できる。
- 音声・動画の実再生用に、オリジナルの合成音・テストパターンから15秒のMP3、Opus Ogg/WebM/MP4、AV1+Opus WebM/MP4を追加した。生成方法は [fixture README](../packages/worker/test/fixtures/README-media-e2e.md) を参照する。自動変換は行わず、保存済み原本を認可済みcontent originから再生する。
- Chrome/Edge/Firefox/Safari、desktop/mobile の実行時可否を support matrix に記録する。browser 名だけで再生成功としない。

## 実再生の確認結果（2026-10-03）

NixOS の Chrome 153.0.8010.52 を Playwright から起動し、隔離HTTPSのapp/content両origin、実Worker・D1・R2 fixtureで確認した。一般利用者としてupload・解析・一覧表示を行い、通常プレイヤーと他利用者を閲覧する管理者プレビューの両方を試験している。

| 原本形式 | 再生とシーク後の継続 | 認証付きRangeのbyte一致 |
|---|---|---|
| MP3 | 成功 | 成功 |
| Opus / Ogg | 成功 | 成功 |
| Opus / WebM | 成功 | 成功 |
| Opus / MP4 | 成功 | 成功 |
| AV1 + Opus / WebM | 成功 | 成功 |
| AV1 + Opus / MP4 | 成功 | 成功 |

音声はdurationとcurrentTimeの進行、動画はさらに実デコードしたframe数の増加を検査し、8秒へのseek後も進行することを確認した。Rangeは206、Content-Range、返却byte列を原本と照合した。管理者のMP3ダウンロードではattachment指定と原本全体のbyte一致も確認した。音声のみのWebM/MP4は動画一覧に混在させない。

この結果は15秒の合成fixtureに対するローカル実ブラウザー試験であり、実CloudflareのAccess/Queuesを含む試験ではない。AV1はMain 8-bit 32×24、Opusはmono 48 kHz。10/12-bit、高解像度・長時間、Firefox/Safari/Edge、mobile、音声出力機器を通した聴取は未確認。原本の自動再エンコードは行わない。

### 2026-10-04 の追加確認

NixOSのChromeで、非公開の実ファイルをAVIF、Opus/MP4、AV1 Main 10-bit + Opus/MP4へ変換し、ローカルと実Cloudflare stagingの両方からupload・解析・表示した。stagingは本人のAccessログインと実Queues/R2/content originを使用し、専用の非公開フォルダーに保存した。

| 対象 | 実Cloudflareでの確認 |
|---|---|
| AVIF静止画 | Gallery一覧、原本680×383のデコード、21,408 bytesの全Range/SHA-256一致 |
| Opus/MP4音声 | 48 kHz stereo、225.251秒、先頭・112秒・220秒からの再生進行、4,749,721 bytesの全Range/SHA-256一致 |
| AV1+Opus/MP4動画 | 1920×1080、10-bit、24fps、247.743秒、先頭・120秒・240秒からのデコードframe増加、60,161,053 bytesの全Range/SHA-256一致 |

原本は保存したまま別ファイルへ変換した。音声はOpus 160 kbps VBR、動画はSVT-AV1 CRF 36/preset 6・5秒keyframe・faststartを採用した。動画は全5,945 frameをデコードし、24 frameごとの248点で測ったVMAF平均98.2575を確認した。この数値はサンプル測定であり、全frameの品質保証ではない。Chrome以外、mobile、12-bit、音声出力機器を通した聴取は引き続き未確認。

仕様根拠: [AVIF brands](https://aomediacodec.github.io/av1-avif/#brands)、[AV1 codec string](https://aomediacodec.github.io/av1-isobmff/#codecsparam)、[Ogg Opus](https://www.rfc-editor.org/rfc/rfc7845.html)、[MP4 Opus](https://opus-codec.org/docs/opus_in_isobmff.html)、[Cloudflare Images の入力制限](https://developers.cloudflare.com/images/get-started/limits/)。2026-09-22 確認。

## 非公開の手元ファイルを使う追加ブラウザー試験

`NCF_USER_MEDIA_MANIFEST` にローカルJSONの絶対パスを指定すると、画像・音声・動画の各1ファイルを実際のfile chooserでアップロードし、Gallery/Audio/Video、再生・シーク、認証付きRangeの全byteとSHA-256を確認する。未指定時はこの追加試験だけをskipする。JSON、対象ファイル、trace、スクリーンショットをrepositoryへ追加しない。

```json
{
  "files": [
    { "path": "/absolute/private/photo.avif", "name": "photo.avif", "kind": "image", "width": 680, "height": 383 },
    { "path": "/absolute/private/audio.m4a", "name": "audio.m4a", "kind": "audio", "durationSeconds": 225.25 },
    { "path": "/absolute/private/video.mp4", "name": "video.mp4", "kind": "video", "width": 1920, "height": 1080, "durationSeconds": 247.74 }
  ]
}
```

```sh
pnpm install --frozen-lockfile
NCF_USER_MEDIA_MANIFEST=/absolute/private/media.json pnpm test:browser
```

この試験は隔離したローカルWorker/D1/R2を使う。Cloudflare Access・実Queues・実R2を含むstaging確認は、別途本人がログインした専用ブラウザーで行う。
