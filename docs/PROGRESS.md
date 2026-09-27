# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[復元後の予約epoch採用](DATABASE_RESTORE_ADOPTION.md)をprivate operator・adopt-epoch CLIへ接続しました。検証済みcontrolの全列を比較する原子的D1 batchで旧凍結/tokenを解消し、予約epoch・新しい停止tokenを設定します。独立CLIがそのtokenを指定先から読み返した後、DOへ同じepochを採用します。完了済みoperationと未終了KDF/R2記録を保持し、採用後もmaintenance・GC停止・復旧holdを維持します。

schema0046・通常68table・依存追加なし。新規Node20/workerd12ケースを含むCLI関連104件・workerd関連134件が成功しました。古いschema、凍結解除のrollback、応答喪失・遅延成功・再送拒否・停止中監査への接続を確認しています。型・lint450file・契約/設定・Web build・Worker dry-runと、全20復旧操作の権限拒否・epoch採用を含むprivate bindingドリルも成功しました。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次は採用後の全監査・R2実体/会計照合・復旧holdの最終解除と段階再開をoperatorへ接続する工程です。未終了のKDF/R2記録や古いbackup記録を成功扱いにせず修復する必要があります。外部I/O全終了の運用証明、安全な中止、logical import、旧実装/全storage喪失からの復旧、大規模DBの再開/RTOも残ります。通知先・timer設置、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。先行fe736b6の[CI36333077770](https://github.com/daraskme/Nextcloud-flare/actions/runs/36333077770)は全5job成功。直前1e2207fの[CI36334806558](https://github.com/daraskme/Nextcloud-flare/actions/runs/36334806558)は記録時点でUbuntu・Windows分割2・browser成功、backup・Windows分割1実行中。今回のpush/CIはgit statusとgh run listで確認します。
