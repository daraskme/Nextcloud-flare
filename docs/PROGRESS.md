# 開発進捗

更新: 2026-09-25

## 確定した到達点

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAVの転送と公開、認証・会計・復旧・共通受付とKDF制限、バックアップ専用の書込み停止をローカル実装済みです。

直前commit bb6e6a6はmainへプッシュ済み。[CI36070823970](https://github.com/daraskme/Nextcloud-flare/actions/runs/36070823970)は全4ジョブ成功。Ubuntu6m25s、Windows 1/2は15m51s（47file/1,016件）、2/2は11m46s（47file/975件）、browser2m9sです。Node432・workerd1,991・browser19、重複を除く計2,442件を確認しました。今回の生成コマンドはこのCIには含まれません。

## 今回の変更

バックアップ生成・整合性検証・新規ファイルへのオフライン復元コマンドを追加しました。凍結中のDBと全67テーブルの内容が一致した世代だけをローカル保存します。

pnpm backupのcapture/verify/restore-offlineを接続しました。実Wranglerのdata-only抽出、全migrationのhash、schemaと各tableの行数/hash、SQL checksumを束縛し、隔離先の同一schema・FK・FTSと容量を検証します。入力SQLは既知のINSERTとliteralだけを解析してbound parameterで取り込み、既存世代・既存DBを上書きしません。成功・失敗とも元のbarrierを保持し、R2公開や稼働再開の成功とは扱いません。

Node32件を追加し、全464件（28file、8.08s）が成功。lint324file・型・契約/設定検査も成功しました。実Wranglerのcapture→verify→restore-offlineが全67table、SQL9,599bytesで成功し、元DBの凍結、容量、FTS検索を確認しました。欠落/内容変化、不正SQL、世代/schema/checksum不一致、既存出力保護、UTF-8/文上限/途中切れを試験しています。Worker本体・migrationは変更せず0037/通常67tableを維持。新しいbackup CI jobで同じドリルを実行します。今回のCIはプッシュ後に確認します。

詳細は[BACKUP_GENERATIONS](BACKUP_GENERATIONS.md)と[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

## 後続の主要項目

ControlDOの運用呼出し経路、R2への世代公開・日次実行/保持管理、旧version・全データ形式の互換性、Time Travelとlive restoreの新epoch/全監査、backup中の全storage喪失からの運用復旧は後続です。旧DAV保留の証明付き回収、未知KDF/multipart、追加event、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。remote migration・deployは未実施です。
