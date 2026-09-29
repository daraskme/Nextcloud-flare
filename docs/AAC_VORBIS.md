# AAC・Vorbisの解析と原本再生

2026-09-29。[Audio](AUDIO.md)へM4A/MP4のAACとOgg Vorbisを追加する。通常upload・匿名upload・WebDAV PUTの完了Outboxから、既存の認可・現在blob・claim・epoch照合を経てMIMEとnode_media/node_audioを保存する。拡張子や申告Content-Typeで形式を決めない。原本URL、共有認可、native player、利用者別位置、download fallbackは既存経路を使う。

## AAC

MP4の音声track、自己完結したdata reference、version 0のmp4a sample entryとesdsを検査する。ES/DecoderConfig/DecoderSpecific/SL descriptorの長さと構成、MPEG-4 Audioのobject type indication、音声stream typeを確認する。暗号化、外部参照、依存stream、重複構成は受け付けない。

AudioSpecificConfigは1KiB以内。AAC-LC coreのsample rate/channel configurationとProgram Config Element（PCE）、明示的またはsync extensionのSBR/PSを読む。正規MIMEは`audio/mp4`にcodecsパラメーターを付け、LC・HE-AAC・HE-AAC v2をそれぞれ`mp4a.40.2`・`mp4a.40.5`・`mp4a.40.29`とする。sample entryのchannels/rateとcore/output設定を照合する。時間とiTunes表示タグは既存MP4 parserで取得する。

既存のmoov探索は4MiB・128 GET以内で、mdat本体は読み飛ばす。実音源は48kHz monoのAAC-LCと、末尾moov・44.1kHz stereo・PCE付きAAC-LCを使う。SBR/PSは構成解析とMIME/APIの試験までで、実HE-AAC音源の復号は未検証。AAC Main/SSR/LD/ELD/xHE、ADTS単体、QuickTime音声entry、AAC付き動画は対象外。fragmented MP4はfragmentの時間取得と実再生を未検証。既存のAV1動画＋Opusは維持する。

## Vorbis

OggのCRC・stream serial・page sequence・lacing・continuationを確認し、identification/comment/setupの3packetを順に読む。ヘッダーはpageをまたげる。identificationのversion/channels/sample rate/block size、表示用Vorbis comment、setupのcodebook/floor/residue/mapping/modeとframingを検査する。codebookの接頭符号の過剰割当て、範囲外参照、予約値、欠けたsetupは拒否する。復号用のHuffman/VQ tableは確保しない。

metadataは先頭2MiB、header packetは1MiB、構造は4,096個以内。codebookの宣言entry合計は65,536、bit読取りは131,072回以内で打ち切る。小さい原本は最終granule/sample rateから時間を求め、大きい原本は3headerを読んだ後に止めて時間をnullにする。正規MIMEは`audio/ogg; codecs="vorbis"`。chained/multiplexed Oggと後方探索は対象外で、上限を超える構成は添付原本として保持する。

## 共通の範囲と検証

Audio一覧と位置更新の最終batchはcodec/MIMEの組合せを確認する。候補1,000件・200曲page・2,000曲上限、全抽出invocationの4MiB・128 GET・25秒は維持する。schema0073・通常79table・149 API route・track-metadata-v1を使い、migrationと依存を追加しない。

合成した4音源でタグ・時間・canonical MIME、破損/変異/I/O失敗、setupの直接検査、Ogg headerのpage継続とchain拒否、1GB仮想Oggの読取り上限を検証する。実D1/R2/Queueで抽出・Range・一覧/本人位置・重複配信と会計を確認する。Browserの実uploadから所有者と匿名共有の原本再生を検証する。結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)に記録する。

これはheaderの解析であり、全audio bitstreamの復号保証ではない。端末のnative decoderが利用できない場合はdownloadへ戻る。cover抽出/変換、override編集/検索、既存原本の再抽出とcopy引継ぎ、Bookshelf、運用修復、実Cloudflareと他OS/browserの検証は継続する。

参照：[Vorbis I specification](https://www.xiph.org/vorbis/doc/Vorbis_I_spec.html)、[MP4 Registration Authority object types](https://mp4ra.org/registered-types/object-types)、[AAC codec registration](https://www.w3.org/TR/webcodecs-aac-codec-registration/)、[FFmpeg AudioSpecificConfig parser](https://github.com/FFmpeg/FFmpeg/blob/master/libavcodec/mpeg4audio.c)。
