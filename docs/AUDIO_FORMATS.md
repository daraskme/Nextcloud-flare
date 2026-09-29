# MP3・FLAC・WAVの解析と再生

2026-09-29。通常upload・匿名upload・WebDAV PUTの既存Outboxへ3形式を追加する。認可・現在node/blob・claim・epochをRange前後と確定batchで照合し、MIME・node_media/node_audio・完了receiptを一括保存する。入力の拡張子・Content-Typeは信用しない。既存のOpusと同じ一覧・常駐player・利用者別位置・共有原本配信へ接続する。

| 形式 | 確認する構造 | 保存する時間・タグ |
|---|---|---|
| MP3 | MPEG 1/2/2.5 Layer IIIの連続3frame、version/sample rate、予約値・frame長・原本範囲 | ID3v2.2/2.3/2.4の曲名・artist・album・track/disc、ID3v1 fallback。Xing/Infoのframe数と正確なstream bytes、またはhead内最大4,096frameの全体走査から時間を取得 |
| FLAC | 最初のSTREAMINFOと一意性、metadata block境界、sample rate/channels/bit depth、先頭frameの構成とCRC8 | 総sample数が既知なら時間。Vorbis commentの同じ表示タグだけを取得 |
| WAVE | RIFF/WAVE全体サイズ、fmt、PCM/IEEE float（extensible GUID含む）、channels/sample rate/byte rate/block align/data範囲 | data bytes/sample rateから時間。head内LIST/INFOのINAM/IART/IPRD/ITRK/IPRTを取得 |

ID3はsyncsafe長、UTF-16 BOM・UTF-8・ISO-8859-1、全体／frame単位のunsynchronization、extended header、v2.4 footerを扱う。暗号化・圧縮frameは展開せず、その表示値を省略する。v2.2のタグ全体圧縮は対象外。ID3v1は末尾128 bytesだけを別Rangeで読み、v2の表示値を優先する。どのencodingも最終UTF-8値が1KiBを超えれば保存しない。任意タグ・埋込画像・外部参照・GPSは抽出しない。

新しい3形式のheadは2MiB・64 GET以内、MP3だけtail128 bytes・1 GETを追加する。parserはheadの外へ探索しない。ImageReaderの32KiB page/cache4page、metadata構造4,096個とQueue invocation全体4MiB・128 GET・25秒の制限を維持する。先行する画像判別の読み取りもinvocation counterへ含む。WAVの大きなdata chunkは整数範囲と実オブジェクトの長さを確認して飛ばす。MP3の大きな原本を時間の推定だけのために全走査しない。

正規MIMEは`audio/mpeg`・`audio/flac`・`audio/wav`。Audio SELECTと位置更新の最終batchはcodecとMIMEの対応を同時に検査する。例えばMP3情報とOpus MIMEが混ざった行は一覧・位置更新の両方から除外する。候補1,000件・200曲page・2,000曲上限は維持する。既存`track-metadata-v1`とschema0073・79通常table・149 routeを使用し、依存・migrationを追加しない。

原本は再エンコード・Blob URL化せず認可済みcontent URLで配信する。native audioの対応判定・decode error・原本download fallbackは既存playerに従う。CSPは解析済みmediaの既存方針（media-src self、sandbox allow-same-origin、script不可）を適用し、Cookie・現在の権限・Rangeを毎回検査する。

## 検証と限界

ローカルFFmpegの合成音源を用いる。Nodeで3形式の実bytes、MPEG 2/2.5、複数ID3版・encoding・unsynchronization・footer、WAVE extensible/float、破損入力・変異入力・I/O障害を検証する。1GBの疎なMP3は末尾128 bytes以外をheadに制限し、WAVは先頭64KiBだけで時間を算出する。実D1/R2/Queueでは認可、抽出、Range、一覧と本人位置、再配信による重複読取りなし、参照/容量会計を確認する。実施結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ記録する。

Header解析は全bitstreamの復号・CRC検査ではない。MP3 free-format/Layer I・IIは対象外で、Xing/Infoから時間を確定できずhead内にも全frameが収まらない場合は時間をnullにする。VBRI専用の時間取得、encoder delay/paddingによるgapless時間補正は未接続。FLAC総sample数0も時間不明。WAVEはlittle-endian RIFFで、RF64/RIFX・圧縮codecは対象外。大きなdataの後ろにあるINFOは取得しない。INFOのencoding宣言がないため、UTF-8として読めない表示値は省略する。

[AAC（M4A/MP4）・Vorbis（Ogg）](AAC_VORBIS.md)は後続で接続済み。cover、override編集/検索同期、既存原本の再抽出/copy引継ぎは継続する。実Cloudflare・他OS/browserの対応表は未検証。

仕様参照：[ID3v2.3](https://id3.org/id3v2.3.0)、[ID3v2.4](https://id3.org/id3v2.4.0-structure)、[FLAC RFC 9639](https://www.rfc-editor.org/rfc/rfc9639.html)、[WAVEFORMATEX](https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatex)、[WAVEFORMATEXTENSIBLE](https://learn.microsoft.com/en-us/windows/win32/api/mmreg/ns-mmreg-waveformatextensible)。MP3 frame/Xingの確認は[FFmpegのheader実装](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/mpegaudiodecheader.c)・[LAMEのVBR tag実装](https://github.com/lameproject/lame/blob/master/libmp3lame/VbrTag.c)を参照した。
