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

Cloudflare Images による AVIF 入力は Enterprise 条件があるため、サムネイルの可否を原本の対応可否と混同しない。
変換 unavailable/failed/pending の場合、detail は認可済み原本、grid は placeholder とし、大量の原本を grid で一括読込みしない。
server derivative は既存の WebP / metadata 除去 / budget / claim fence に従う。client thumbnail 受付は追加しない。

## 実装と残る確認

- 実装済み: bounded container sniff、AV1/Opus の MIME/codec string、native probe adapter、AVIF 原本/derivative 選択。単体20件。
- [画像メタデータ](IMAGE_METADATA.md): JPEG/PNG/WebP/AVIFのbounded header/EXIF、通常upload・DAV PUTの完了Outbox、現在のblob/claimに限定したnode_media/MIME保存を接続。変換なしで既存原本配信へimage MIMEを渡す。
- [画像変換の費用・終了記録](IMAGE_COSTS.md): 同じblob・variant・generatorの再課金を防ぐ内部台帳。成功と未実行の事実を復旧時も保持し、不明結果をバックアップ・再開の判定に含める。sm/mdのQueue・R2保存・thumb配信へ接続済み。
- [サムネイル変換の内部実行部](IMAGE_TRANSFORMS.md): 条件付きR2ストリームから静止画sm/md/lg WebPを生成・検査する。JPEG/PNG/WebP/AVIF/10-bit・alpha・EXIF除去をローカルで検証済み。費用claim・sm/mdのQueue・R2保存/配信へ接続済み。[lg受付](LARGE_THUMBNAILS.md)も接続済み。実環境検証は残る。
- [Gallery](GALLERY.md): Queue生成済み画像を所有者・内部共有・公開リンクのgrid/list/lightboxへ接続。原本AVIFの表示、thumbnail unsupported時のplaceholder、現在のblob/generator・認可を確認する。
- [AV1/Opusの情報抽出と動画再生](TRACK_METADATA.md): MP4/WebMのAV1とOgg/WebM/MP4のOpusをbounded parserで解析し、現在の原本と認可に束縛したMIME・寸法・時間・限定タグを保存する。Galleryの動画player、FilesからのOpus原本再生、認可済み原本ダウンロードへ接続。
- [Audio一覧・常駐player・利用者別の位置保存/再開](AUDIO.md): 所有者・内部共有・公開リンクへ接続。SPA遷移中の再生、Content-Session更新、競合時の明示的な再読を扱う。
- 未接続: その他の音声形式、既存データ再抽出/copy後の引継ぎ、Bookshelf。各phaseの残件を継続する。
- 必須 fixture: AVIF 静止画/sequence、AV1 MP4/WebM（音声なし/Opus付き、8/10-bit）、Opus Ogg/WebM/MP4、偽装拡張子/truncated header、seek/Range、再生不可表示、AVIF derivative unavailable 時の原本表示。
- Chrome/Edge/Firefox/Safari、desktop/mobile の実行時可否を support matrix に記録する。browser 名だけで再生成功としない。

仕様根拠: [AVIF brands](https://aomediacodec.github.io/av1-avif/#brands)、[AV1 codec string](https://aomediacodec.github.io/av1-isobmff/#codecsparam)、[Ogg Opus](https://www.rfc-editor.org/rfc/rfc7845.html)、[MP4 Opus](https://opus-codec.org/docs/opus_in_isobmff.html)、[Cloudflare Images の入力制限](https://developers.cloudflare.com/images/get-started/limits/)。2026-09-22 確認。
