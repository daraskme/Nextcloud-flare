# 開発進捗

更新: 2026-09-25

## 確定した到達点

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。

直前commit `6711235`の[CI36076928005](https://github.com/daraskme/Nextcloud-flare/actions/runs/36076928005)は全5ジョブ成功。Node527・workerd2,009（Windowsは1,034+975）・browser19、重複を除く計2,555件と実CLI復元ドリルが成功しました。Ubuntu7m33s、Windows1/2は13m59s・2/2は10m39s、backup2m33s、browser2m12sです。今回の運用コマンドはこのCIに含まれません。

## 今回の変更

専用BackupOperator service bindingと、run/receipt/cancelの運用コマンドを追加しました。runは同じUUID/epochで停止→抽出→全SQL検証→R2保存→完了記録を呼び出し、失敗時は自動中止せず同じ世代から継続します。

専用capability、target側の明示的な有効化、bindingの用途・環境を全操作で検査します。通常の利用者HTTP routeは増やしていません。D1の完了応答を失った再実行もControlDOのintentを収束させます。実CLIの接続で見つかったlocal R2のcwd/config間の保存先相違も修正しました。schema0038・通常67table・依存は維持しています。

Node25件を追加し、全552件（33file、19.71s）が成功しました。専用bindingの実ControlDO/D1/R2ドリルは67table・SQL9,613bytesで成功し、全4操作の権限/環境/無効化、eviction後の再実行、取消・履歴、復元先のFTS/会計を確認しました。R2保存先修正後の実CLI run→receipt→download→restore-offlineもSQL9,110bytesで成功し、同じ引数の再実行と元policyへの復帰を確認しています。従来CLIのcapture/publish/download/restore-offlineも修正後に67table・SQL9,599bytesで成功しました。全体checkも成功し、Node552件＋workerd2,009件（95file）の計2,561件、lint・型・契約・設定検査、Web buildとWorker dry-runを確認しました。

専用service bindingを持つ運用者だけがSQL検証済みhashを証言します。remote Cloudflareの認証・権限・実resourceによる運用検証は未実施です。日次実行・保持管理、元BLOBS保護、live復旧、全storage喪失からの運用復旧は未完了です。

詳細は[BACKUP_OPERATOR](BACKUP_OPERATOR.md)、[BACKUP_COMPLETION](BACKUP_COMPLETION.md)、[BACKUP_GENERATIONS](BACKUP_GENERATIONS.md)、[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

## 後続の主要項目

次は日次実行・最大35日/最少5世代の保持管理とバックアップ対象BLOBSの保護を進めます。旧version/全データ形式、Time Travel・新epoch・全復旧監査、旧DAV保留の証明付き回収、未知KDF/multipart、追加event、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。remote migration・deployは未実施です。
