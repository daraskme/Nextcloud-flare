# ZIP/CBZ・EPUBコンテナの読み取り基盤

アーカイブの索引解析・エントリのストリーム展開に加え、新しいZIP/CBZ/EPUBアップロードのQueue索引化と不変R2保存を接続した。schema0077・通常81table・151 API route。Library API・ページ配信・画面は開発中で、本棚全体はまだ利用できない。

## 実装済み

- `media/archive/index.ts`: 末尾最大1MiBとcentral directory最大8MiBのRangeを読む。小さい索引が末尾範囲に収まれば取得済みbytesを再利用する。本文の展開や全原本のバッファ化はしない。空ZIP、STORE、DEFLATE、単一diskの通常ZIP64 record/extra fieldに対応する。
- 件数10,000・単一展開64MiB・合計展開8GiB・索引JSON8MiBの上限を適用する。圧縮入力は1エントリ64MiB+64KiBまで。ZIP64の値はsafe integerを確認してから数値化し、4GiBを超えるoffsetも保持する。
- 名前はUTF-8、CP437、CRCが一致するUnicode Path extraを扱う。NFCへ正規化し、絶対パス、ドライブ指定、逆斜線、制御文字、空/`.`/`..`成分、重複・親子のファイル衝突を拒否する。名前1,024 bytes、深さ64まで。Shift-JIS等の推測はしない。
- 暗号化、未対応method/flag、分割disk、Unix/macOSのsymlink等、重複/壊れたextra、範囲外/重複したlocal headerを拒否する。central順と物理配置順を別々に検査する。
- JPEG/PNG/WebP/GIF/AVIFの拡張子をページ候補として、ロケールに依存しない自然順にする。長い数字を浮動小数点に変換しない。候補は画像形式の検証済みMIMEを意味しない。
- `entry.ts`: local/centralの元の名前bytes・正規化名・version・flags・method・CRC・サイズを照合し、descriptor付きの場合は許される未確定値を認めたうえでdescriptorを検査する。32/64bit、署名あり/なし、CRCと署名値が偶然一致する場合に対応する。
- STOREは直接、DEFLATEはnative `DecompressionStream('deflate-raw')`で展開する。展開後のchunk全体を宣言サイズ・64MiB上限と比較してから、最大64KiBずつ渡す。EOFで正確なサイズとCRCを検査する。CRC不一致は本文配信後にも起こるため、stream errorを返す。HTTP statusを後から変更できるとは扱わない。
- `r2Source.ts`: 固定したkey/size/ETagへの条件付きRangeのみを使い、応答のobject tuple・range・実body長を照合する。GET前に読み取り回数/bytesを予約し、取得前後とchunkごとに呼出元の認可callbackを確認する。deadline/cancel、GETの遅い応答、停止したbodyを処理する。

`codec.ts`は原本のowner/blob/key/size/ETagと索引を8MiB以内のJSONへ固定し、SHA-256を付ける。読戻しはhash・元tuple・厳密なfield集合・パス・entry範囲・自然順ページを再検査して不変indexを返す。`openArchiveEntry`には`inspectArchive`または`decodeArchiveIndex`の結果を渡す。index・entry ordinal・pathは認可情報ではない。呼出元は原本保持、現在のEffectiveLive、principal/share scope、blob/generator/epoch、期限を検査するcallbackとAbortSignalを用意する必要がある。

ZIP64 extensible data sector、central digital signature、自己解凍用のoffset補正、暗号化、圧縮方式0/8以外は扱わない。エラーコードからのLibrary状態・案内文への変換も後続で接続する。

## 新しいアップロードの索引保存

`dav.put` / `upload.complete`の保存済みprincipalと原本blob stepを使い、現在のnode・親・原本tuple・epoch・Outbox claimを確認する。ZIP/CBZ/EPUBの拡張子を対象とし、祖先を含む非表示・削除を拒否する。索引用RangeはQueue invocation全体で最大4回・9MiB、既存の25秒処理期限内。画像/音声判定用の読み取りには既存の別予算を適用する。

生成したbytesとSHA、件数をControlDOの独立履歴へ登録し、D1で物理容量の予約・output blob・永続job pinを一括作成する。Images変換は呼ばない。共通のR2送信記録で`archive.put`を一度だけ許可し、条件付きPUTの実結果を会計へ記録する。保存中の失効やepoch変更後も実容量を記録し、公開は新しい認可検査に通った場合だけ行う。索引のbytesは論理的なファイル使用量を増やさず、物理容量として計上する。既存名の`image_reserved_bytes`にはこの物理専用予約も含む。

Outboxの完了時に`archive_index`と`library_items`を一括反映する。保存済み出力は再PUTせず、新しいclaimで公開を再開できる。元の索引生成Rangeも繰り返さないが、既存のファイル種別判定は再確認する。形式の確定的な不正・未対応はversion付き失敗として記録する。予算切れ、権限失効、原本差替え、結果不明のPUTは形式不正に変換しない。EPUBはコンテナの索引までで、本文・目次・ページ数の解析は後続。

期限切れ/旧epochの未公開索引と、原本が物理削除へ進んだ公開済み索引を回収する。ControlDOの永続sealで今後の書込みを止め、実容量の記録または上限付きHEADの後だけ予約とpinを解放する。実体があれば35日のバックアップ猶予を付けてGCへ渡す。原本が残る公開済み索引は保持する。1回最大8件・25秒、HEADはleaseにつき1回・索引世代につき64回。独立履歴欠落や未知PUTは保留する。既存の奇数分Cronで画像回収と先行順を交互にし、復元後は`repair-restored --kind archives`から同じ回収を使う。

0077は停止・未凍結・native処理の終了を要求し、既存R2 receiptとguard・既存archive indexを保持する。新しい2表はbackup/restore凍結と全テーブルexportへ含める。`archive_index.r2_key`の単独uniqueを外し、将来の同一所有者COPYで同じ出力を参照できる形にしたが、COPYのLibrary接続はまだ実装していない。

## 次の接続

1. 既存ファイルの索引要求、現在の読者での再抽出、COPY先との連携、失敗状態の案内を接続する。今回の自動索引化は新しいアップロードの元イベントを対象とする。
2. 原本・索引世代・現在認可に固定したpage/entry配信、画像本文の形式検査、content host分離、表紙/ページthumb、private/internal/public Library APIを接続する。
3. 本棚と画像リーダー、フォルダー書籍・PDF、EPUBのOPF/目次解析・サニタイズ・二重iframeのtrusted shell、利用者/node/blob別の読書位置を接続する。

## 参照仕様

ZIPのrecord・ZIP64・descriptor・Unicode extraは[PKWARE APPNOTE](https://pkware.cachefly.net/webdocs/casestudies/APPNOTE.TXT)、native DEFLATEの形式と失敗条件は[WHATWG Compression Standard](https://compression.spec.whatwg.org/)を確認した。製品上限・認可・EPUB分離は[DESIGN](DESIGN.md) §9A/§10と[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) Phase8Bに従う。設計追加レビューの古い案より現行DESIGNを優先する。
