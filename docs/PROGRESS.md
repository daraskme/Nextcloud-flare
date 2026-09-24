# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commit943712fはmainへプッシュ済み。[CI36051299505](https://github.com/daraskme/Nextcloud-flare/actions/runs/36051299505)はUbuntu・Windows・browserすべて成功しました。Node422/workerd1698/browser19、計2,139件を確認済みです。Ubuntu7分37秒、Windows16分47秒、browser2分18秒。今回の全bucket受付はまだ含まれません。

## 今回の変更

全bucketの未完了multipart調査・中止を共通global受付へ接続しました。scanとpartの開始・外部予算・ページ保存、中止の開始・結果保存の8経路が、通常操作と同じ32 active/256 waiting枠を使います。

所有者が未復元でもscopeは明示nullです。受付待ち後にfresh proof・epoch/mode/pauseとscan/partの元のround・cursorを再検査します。S3一覧とR2 abortは直接ACK後だけ送信し、probe開始から固定25秒の開始期限を受付後・ACK後にも検査します。初期化と中止結果のDB-only更新は自分の確定記録だけを照合し、一覧の結果付きbatchは応答喪失時に推測で成功を返しません。同じ中止attemptは再送せず、64回の生涯上限と容量保留を維持します。ControlDO内部は同じinstanceの受付を使います。

workerd82件を追加（境界73件・実ControlDO9件）。関連109件（97.66s）と全体checkが成功。Node422件（25file、5.68s）・workerd1,780件（83file、971.26s）、計2,202件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

旧epoch repairの残る更新受付とbackup barrier、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
