# 進捗概要

更新: 2026-09-29。コード基準 `81b351e`。**現在の完了範囲・未完了・検証状態は [CURRENT_STATE](CURRENT_STATE.md) が正本。** この文書は最近の変更を短く追うための記録で、製品の完成宣言ではない。

## 今回：状態資料の整理

ユーザー依頼に合わせ、README・CURRENT_STATE・HANDOFF・本書を整理した。実装済み／残件、直近の対象限定検証／過去の検証／実環境の未検証を分離し、契約数を完成API数と混同しない表記へ修正した。Audioのタグ検索、Galleryの既存原本抽出、復旧・実装ブリーフの古い説明も更新した。

アプリ・schema・依存は変更していない。全アプリ試験を今回再実行したとは扱わない。今回の文書確認は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) の資料整理の項目へ記録する。

## 最近の実装

以下の件数は各変更時点の関連試験であり、異なる行の合計や現在HEADの全回帰件数として使わない。詳細な実行条件・失敗／再実行・ログは [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) を参照する。

| コミット | 実装したこと | 検証・制限 |
|---|---|---|
| `81b351e` | 同じ所有者内の単一／フォルダー／再COPYで書籍索引・metadataを再利用。読書位置は独立。COPY/MOVEのmanifest digestを最大1,000件のID列に対応 | 関連202件（Node37・workerd164・Chrome1）。修正途中の成功と再実行の集計。最終修正後はNode37・workerd77・Chrome1。400冊COPY/MOVEを確認。全suiteではない |
| `6ec3a5c` | 本棚一覧、個人の登録フォルダー、内部／公開共有の本棚画面 | 関連172件（Node46・workerd118・Chrome8）。212冊ページング、疎な50,050件候補探索。空pageのUI試験のみ応答fixture使用 |
| `55daa6a` | ZIP/CBZの本人の読書位置を保存・再開。共有受信者との分離とCAS競合処理 | 関連169件（Node38・workerd127・Chrome4）。匿名公開には保存／開示しない |
| `75f18f8` | 原本と索引世代に束縛したZIP/CBZページ配信・共有reader | Node／workerd／Chromeの記録あり。single-hostはattachment／原本fallback。EPUB本文・page thumb・汎用entry配信は対象外 |
| `35bb5b6` | 新規uploadのarchive索引をQueueからR2へ保存、会計・公開再開・回収・復元repair | migration0077、通常81テーブル。未知PUTや独立履歴欠落は保留 |
| `f296561` | 上限付きZIP/CBZ/EPUBコンテナ解析・entry stream | パス・サイズ・CRC・STORE／DEFLATE／ZIP64等の境界を検証。EPUB本文readerではない |
| `7706740` | 古い画像／音声／動画の情報抽出をFilesから明示要求 | 現在の閲覧権限を再検査。自動一括走査や書籍索引要求は対象外 |
| `b1975e1` | 既存音声・所有者間COPY先の埋め込み表紙をplayerから要求 | 音声表紙の既存解析・変換・保存契約を利用。未対応parser領域は残る |

これ以前に、Files・upload・コピー・内部／公開共有・WebDAV・ZIPダウンロード・Gallery・Audio・バックアップ／復旧・DLQの各ローカル経路を実装した。分野別の範囲と未接続経路はCURRENT_STATEの表で確認する。

## 次の作業

既存／未索引／コピー済み書籍の索引要求が次の実装候補。今回の資料整理時点では未実装。その後は本棚readerの残り、大規模処理・media保守、未知nativeを含む復旧、全体回帰・実環境gateを進める。具体的な参照先・作業条件は [HANDOFF](HANDOFF.md) にまとめた。

pushは既存の自動承認審査拒否後の宛先確認待ちで、ローカルcommitに保持する。今回remote照会・Cloudflare操作はしていない。

## 履歴の扱い

過去CIの成功・未解決失敗、試験件数、ログと制限はIMPLEMENTATION_STATUSに保持する。古い「未実装」「今回」の文章を現在の残件へ転載しない。整理前の本書は `git show 81b351e:docs/PROGRESS.md` で参照できる。
