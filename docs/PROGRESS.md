# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

Time Travelの[一度限りの送信と実応答記録](DATABASE_RESTORE_TIME_TRAVEL.md)をControlDO・private operator・CLIへ接続しました。要求・予約epoch・DB/BLOBS/BACKUPS・bookmark・元の時刻を固定し、送信前にDOへpendingを保存します。結果不明は再送せず、成功応答もD1の巻戻し対象外へ記録します。成功後も旧DO epochと停止を維持し、snapshot照合・予約epoch採用は後続です。送信は既定で無効です。

schema0046・通常68table・依存追加なし。新規Node34/workerd22ケースを追加し、CLI関連94件・workerd関連155件を確認しました。型・lint439file・契約/設定・Web build・Worker dry-runと、全16復旧操作の権限拒否を含むprivate binding運用ドリルが成功。Windows CIで見つかった既存multipart試験の待機競合も修正し、その19件が成功しました。今回の全体CIはpush後に確認します。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次は外部I/O全終了の運用証明、復元後snapshot照合・予約epoch採用・全監査・段階再開です。結果不明や予約後の安全な中止、logical importも残ります。RESTORE_WRITE_ENABLEDの設定は終了証明の代替になりません。旧実装や全storage喪失時の終了証明、通知先・timer設置、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。先行5269505の[CI36329896475](https://github.com/daraskme/Nextcloud-flare/actions/runs/36329896475)と86d4b6eの[CI36331228499](https://github.com/daraskme/Nextcloud-flare/actions/runs/36331228499)で、Windows分割1の同じmultipart試験がタイムアウトしました。今回、native送信開始後にタイマーを進めるfixtureへ修正しています。86d4b6eはUbuntu・Windows分割2・browser成功、記録時点でbackup実行中。以前の77623a7と3f2217bは全5job成功済み。今回のpush/CIはgit statusとgh run listで確認します。
