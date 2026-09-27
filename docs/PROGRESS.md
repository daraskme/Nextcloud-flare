# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

復元後の[全テーブル照合と隔離SQL検証](DATABASE_RESTORE_SNAPSHOT.md)をprivate operator・CLIへ接続しました。元の復旧要求・予約epoch・対象3binding・実行結果に観測を束縛し、信頼済みschema、全行のhash、外部キー、隔離FTS再構築を検証します。古いschemaのsnapshotも自動移行せず照合でき、D1の内容と旧DO epoch・停止を維持します。結果はDOへ保存しますが、epoch採用の許可には使いません。

schema0046・通常68table・依存追加なし。新規Node17/workerd16ケースを含むCLI関連150件・workerd関連138件、型・lint445file・契約/設定・Web build・Worker dry-runが成功しました。全18復旧操作の権限拒否と、復元後68table・SQL57,492bytesの隔離検証を含むprivate bindingドリルも成功。今回の全体CIはpush後に確認します。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次は復元後D1を採用用の停止tokenへ正確に束縛し、旧backup/restore token・permit/claimを処理して予約epochを採用する工程です。今回の読取り証言は、検証後の全行不変性や新しいbinding identityを保証しません。外部I/O全終了の運用証明、全監査・段階再開、安全な中止、logical import、旧実装/全storage喪失からの復旧も残ります。通知先・timer設置、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。記録時点でfe736b6の[CI36333077770](https://github.com/daraskme/Nextcloud-flare/actions/runs/36333077770)はUbuntu・Windows2分割・browser成功、backup実行中。先行5269505/86d4b6eで失敗したmultipart待機fixtureはfe736b6で修正し、Windows分割1の成功を確認しました。今回のpush/CIはgit statusとgh run listで確認します。
