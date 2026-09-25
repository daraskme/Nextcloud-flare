# 開発進捗

更新: 2026-09-25

## 確定した到達点

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得をローカル実装済みです。

直前commit `8f0454b`の[CI36074335530](https://github.com/daraskme/Nextcloud-flare/actions/runs/36074335530)は全5ジョブ成功。Ubuntu7m36s、Windows 1/2は17m11s・2/2は13m24s、backup2m36s、browser2m35sです。Node505・workerd1,991（Windowsは1,016+975）・browser19、重複を除く計2,515件と実local R2復元ドリル（67table・SQL9,599bytes）を確認しました。今回の完了記録はこのCIには含まれません。

## 今回の変更

R2保存済みバックアップの完了記録をControlDOへ接続しました。信頼されたSQL検証者のmanifest hashを固定し、実BACKUPSの世代・各partを照合します。全partの検証後、D1のcompleted記録と元の受付/GC設定への復帰を同じbatchで確定します。

完了までのcursor/hashをDO SQLiteへ保存し、evictionや途中失敗から同じ世代を継続できます。commitとprimary照合の両応答を失ってもintentを保持します。遅延R2/DB要求、同時検証、cancel/次世代との競合を検査し、元がclosedならclosedへ戻して保留uploadの容量も維持します。migration0038はterminal receiptの必須形状と不変性を追加します。通常67tableは維持しています。

Node22件・workerd18件を追加し、全体checkが成功しました。Node527件（32file、14.22s）・workerd2,009件（95file、1,085.53s）、計2,536件を検証しています。lint335file・型・契約/設定検査・Web build・Worker dry-runも成功。schema0038で実CLIのcapture→verify→local R2 publish→download→restore-offlineが67table・SQL9,599bytesで成功しました。今回commitのCI/browserはプッシュ後に確認します。

completeBackupは内部RPCです。SQL/source/schema/FK/FTSの全検証は信頼された生成コマンドが担い、ControlDOはそのhashでR2実体を再検査します。利用者が指定したhashを転送する公開APIは追加していません。CLIからの認証付き運用接続、元BLOBSの保護、live復旧、全storage喪失からの運用復旧は未完了です。

詳細は[BACKUP_COMPLETION](BACKUP_COMPLETION.md)、[BACKUP_GENERATIONS](BACKUP_GENERATIONS.md)、[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

## 後続の主要項目

次は認証付き運用処理でbegin→capture→verify→publish→completeを接続し、一連の復元ドリルを実行します。日次実行・最大35日/最少5世代の保持管理、旧version/全データ形式、Time Travel・新epoch・全復旧監査も後続です。旧DAV保留の証明付き回収、未知KDF/multipart、追加event、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。remote migration・deployは未実施です。
