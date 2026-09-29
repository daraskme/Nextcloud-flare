# 音声タグの検索準備

2026-09-29。migration0074で`node_audio`に検索用の正規化データを追加した。原本の音声タグ抽出と利用者のoverride編集・resetで、現在の曲名・artist・albumから同時に生成する。検索API/FTSへの接続は後続で、現在の検索結果はファイル名を対象とする。

## 保存する情報

`search_text_norm`、`search_tokens`、`search_source`、`search_version`を保存する。各fieldの実効値は`override ?? extracted`で、sourceは曲名・artist・albumの順のJSON配列。名前のfallbackはこのcacheへ含めず、将来の索引更新で現行ファイル名と組み合わせる。

NFKC・Unicode17 casefold・カタカナ/ひらがなの統一・bigram生成は既存の名前検索と共有する。metadataにはファイル名の禁止記号制約を適用せず、スラッシュ・コロン・引用符も保持する。field間は改行で区切る。検索queryは制御文字を拒否するため、隣り合うfieldをまたいだ偽のsubstring一致を作らない。

各fieldはUTF-8で1KiB以内。互換文字の正規化による展開を切り捨てずに扱うため、正規化textは64KiB、tokensは192KiB、sourceは32KiB、versionは128byteを上限とする。WorkerとSQLの両方で上限を確認する。空/未作成のcacheと、全fieldがnullの正しく生成されたcacheはsource/versionで区別する。

## 競合・移行・復元

抽出は同じblobのoverrideだけを引き継ぐ。保存前に既存rowのblobとoverride3値を固定し、確定batchの最初に再照合する。読み取り後のinsert/update/deleteを検知すると、metadataとcacheを一切確定せずOutboxを再試行する。元の認可、現在のblob、Range/ETag、claim/epochと読み取り予算の検査も維持する。

利用者の編集は既存のmetadata snapshot検査と同じbatchでoverrideとcacheを更新する。resetでは最新の抽出値から再生成する。5段階のoperation receiptとidempotencyの形式は変更しない。

`AUDIO_SEARCH_CURRENT`はcacheのversionと実効3値のJSON一致を検査する内部SQL式。将来の索引更新では、これに加えてnodeの現在blob、generator、codec/MIME、認可範囲を確認する必要がある。この式単独は現在の原本や閲覧権限の証明にはならない。

migrationはmaintenance中で、open permit・claimed operation・未閉鎖mutation枠・未終了R2/KDF/Images試行とbackup/restore凍結がない場合だけ実行する。通常79table・149 API routeは維持する。既存タグは保存したまま、新columnは空文字にする。旧データを正規化済みと推測しない。既存のbackup/restore凍結triggerは追加columnにも適用され、export/restoreは4columnをそのまま扱う。

## 次の接続

- 抽出/override確定と同じtransactionでFTS旧値削除・base索引更新・FTS新値挿入を行う。
- 改名・MOVE・ごみ箱復元では実効タグを保持し、原本の上書きでは旧blobのタグを即時に外す。
- 同一所有者COPYと、受付時metadataを固定する所有者間COPYへ引き継ぐ。
- 既存cacheなしの音声と旧versionを、上限付きで再構築する。既存のoperation receiptを壊さず、競合と再試行を検証する。

検証結果は[実装進捗](IMPLEMENTATION_STATUS.md)を参照。実Cloudflareへのmigration・配備は未実施。
