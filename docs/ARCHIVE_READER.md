# ZIP/CBZ・EPUBコンテナの読み取り基盤

Bookshelfの最初の段階として、アーカイブの索引解析とエントリのストリーム展開を実装した。まだLibrary API・Queue・画面へ接続していないため、この変更だけで本棚を利用できる状態ではない。schema0076・通常79table・151 API routeを維持し、migrationと依存追加はない。

## 実装済み

- `media/archive/index.ts`: 末尾最大1MiBとcentral directory最大8MiBのRangeを読む。小さい索引が末尾範囲に収まれば取得済みbytesを再利用する。本文の展開や全原本のバッファ化はしない。空ZIP、STORE、DEFLATE、単一diskの通常ZIP64 record/extra fieldに対応する。
- 件数10,000・単一展開64MiB・合計展開8GiB・索引JSON8MiBの上限を適用する。圧縮入力は1エントリ64MiB+64KiBまで。ZIP64の値はsafe integerを確認してから数値化し、4GiBを超えるoffsetも保持する。
- 名前はUTF-8、CP437、CRCが一致するUnicode Path extraを扱う。NFCへ正規化し、絶対パス、ドライブ指定、逆斜線、制御文字、空/`.`/`..`成分、重複・親子のファイル衝突を拒否する。名前1,024 bytes、深さ64まで。Shift-JIS等の推測はしない。
- 暗号化、未対応method/flag、分割disk、Unix/macOSのsymlink等、重複/壊れたextra、範囲外/重複したlocal headerを拒否する。central順と物理配置順を別々に検査する。
- JPEG/PNG/WebP/GIF/AVIFの拡張子をページ候補として、ロケールに依存しない自然順にする。長い数字を浮動小数点に変換しない。候補は画像形式の検証済みMIMEを意味しない。
- `entry.ts`: local/centralの元の名前bytes・正規化名・version・flags・method・CRC・サイズを照合し、descriptor付きの場合は許される未確定値を認めたうえでdescriptorを検査する。32/64bit、署名あり/なし、CRCと署名値が偶然一致する場合に対応する。
- STOREは直接、DEFLATEはnative `DecompressionStream('deflate-raw')`で展開する。展開後のchunk全体を宣言サイズ・64MiB上限と比較してから、最大64KiBずつ渡す。EOFで正確なサイズとCRCを検査する。CRC不一致は本文配信後にも起こるため、stream errorを返す。HTTP statusを後から変更できるとは扱わない。
- `r2Source.ts`: 固定したkey/size/ETagへの条件付きRangeのみを使い、応答のobject tuple・range・実body長を照合する。GET前に読み取り回数/bytesを予約し、取得前後とchunkごとに呼出元の認可callbackを確認する。deadline/cancel、GETの遅い応答、停止したbodyを処理する。

`openArchiveEntry`には、その原本から解析した不変のindexだけを渡す。永続JSONの復元検証はまだ実装していない。index・entry ordinal・pathは認可情報ではない。呼出元は原本保持、現在のEffectiveLive、principal/share scope、blob/generator/epoch、期限を検査するcallbackとAbortSignalを用意する必要がある。今回の試験はcallbackの失効伝播を検証しており、Libraryの認可APIが接続済みという意味ではない。

ZIP64 extensible data sector、central digital signature、自己解凍用のoffset補正、暗号化、圧縮方式0/8以外は扱わない。エラーコードからのLibrary状態・案内文への変換も後続で接続する。

## 次の接続

1. 現在の読者で要求を受け付け、Outbox・保存principal・epoch・fenced claimで索引を作成する。索引の不変R2保存・容量予約/精算・回収と永続JSON検証を接続する。
2. 原本・索引世代・現在認可に固定したpage/entry配信、画像本文の形式検査、content host分離、表紙/ページthumb、private/internal/public Library APIを接続する。
3. 本棚と画像リーダー、フォルダー書籍・PDF、EPUBのOPF/目次解析・サニタイズ・二重iframeのtrusted shell、利用者/node/blob別の読書位置を接続する。

## 参照仕様

ZIPのrecord・ZIP64・descriptor・Unicode extraは[PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)、native DEFLATEの形式と失敗条件は[WHATWG Compression Standard](https://compression.spec.whatwg.org/)を確認した。製品上限・認可・EPUB分離は[DESIGN](DESIGN.md) §9A/§10と[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) Phase8Bに従う。設計追加レビューの古い案より現行DESIGNを優先する。
