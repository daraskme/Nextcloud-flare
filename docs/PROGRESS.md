# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[受信者のShared画面](SHARED_WORKSPACE.md)を追加しました。受信一覧からフォルダー配下を閲覧し、ファイルを開いて保存できます。選択した共有ID/versionをmetadata・cursor・content ticketへ固定し、共有より上のフォルダー名と親IDを返さないよう修正しました。[所有者の共有管理](INTERNAL_SHARES.md)と共有停止後の失効も接続済みです。

schema0048・通常69table・migration/依存追加なし。全体check成功：Node62file/1,311件、workerd122file/2,677件。全browser24件も成功し、計4,012件を確認しました。lint482file・型・契約/設定・Web build/Worker dry-runも成功。mobile表示を確認済みです。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次は選択した共有を保つfolder作成・改名・uploadを接続します。再送・operation照会・Outbox・UploadDO・復旧検査まで共有選択を保持する必要があります。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、旧実装/全DO喪失に由来する未記録処理の終了証拠が不足しており、保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、公開link/upload-only/ZIP、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

送信先は承認済みGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。先行a5c7aa0の[CI36351626854](https://github.com/daraskme/Nextcloud-flare/actions/runs/36351626854)はUbuntu・Windows3分割・browser・backupの全6job成功。今回のpush/CIはgit statusとgh run listで確認します。
