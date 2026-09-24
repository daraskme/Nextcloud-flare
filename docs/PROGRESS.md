# 開発進捗

更新: 2026-09-25

## 確定した到達点

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAVの転送と公開、認証・会計・復旧・共通受付とKDF制限、バックアップの書込み停止・生成・検証をローカル実装済みです。

直前commit `2b6f23f`の[CI36072846945](https://github.com/daraskme/Nextcloud-flare/actions/runs/36072846945)は全5ジョブ成功。Ubuntu7m42s、Windows 1/2は14m50s・2/2は13m40s、browser2m14s、backupドリル2m31s。Node464・workerd1,991・browser19、重複を除く計2,474件と67tableの復元を確認しました。今回のR2保存・ダウンロードはこのCIには含まれず、プッシュ後のCIで確認します。

## 今回の変更

検証済みの論理バックアップをR2へ保存し、ダウンロード後に再度復元検証するコマンドを追加しました。8MiBごとのpartを条件付きで保存・読戻しし、SQL全体のhashを確認してからmanifestを最後に確定します。応答喪失時は実objectを照合し、同じ世代の再実行で一致済みpartを再利用します。既存世代を上書きしません。

Node41件を追加し、全505件（30file、12.43s）が成功。lint329file・型・契約/設定検査も成功しました。実Wranglerのcapture→verify→local BACKUPS publish→download→restore-offlineが67table・SQL9,599bytesで成功し、実R2の条件競合、FTS/FK/容量、元DBの凍結保持を確認しました。8MiB超の複数part、途中失敗からの再開、ACK喪失、同時公開、改変/欠落、期限・本文上限・署名を試験しています。Worker本体・schema0037・通常67table・依存は変更していません。

保存対象はD1の論理SQLで、元のBLOBS object本体は含みません。barrier解除・backup_runs.completed・live復旧は未接続です。local R2は検証済み、remote S3経路は実装済みですが実環境では未検証です。途中失敗partのdeleteや自動回収は行いません。

詳細は[BACKUP_GENERATIONS](BACKUP_GENERATIONS.md)と[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

## 後続の主要項目

ControlDOの認証付き運用呼出し経路、保存先との対応検証・D1の完了receipt、日次実行/保持管理、旧version・全データ形式の互換性、Time Travelとlive restoreの新epoch/全監査、backup中の全storage喪失からの運用復旧は後続です。旧DAV保留の証明付き回収、未知KDF/multipart、追加event、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。remote migration・deployは未実施です。
