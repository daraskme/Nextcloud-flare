# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[内部共有の管理](INTERNAL_SHARES.md)を追加しました。Filesから共有の作成・権限/相手/期限の変更・停止を行えます。所有者一覧と受信一覧API、固定mount名、変更時の旧grant/session/ticket失効を接続しています。受信者のShared画面、DAV Shared、公開linkは後続です。

schema0048・通常69table・依存追加なし。全Node62file/1,294件、関連workerd 4file/63件、全ブラウザー22件が成功しました。型・lint479file・契約/設定・69table schema生成・Web build/Worker dry-runも成功。mobile表示を確認済みです。詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次は受信者のShared画面と、選択した共有を保つcontent/upload操作を接続します。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、旧実装/全DO喪失に由来する未記録処理の終了証拠が不足しており、保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、公開link/upload-only/ZIP、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

送信先は承認済みGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。前回53bfc16の[CI36349203224](https://github.com/daraskme/Nextcloud-flare/actions/runs/36349203224)はLinux/Windowsで旧migration数期待値（46→実際47）が失敗し、今回修正しました。前回Linuxは他2,641件成功。ほかのWindows2分割・browser・backupは成功。先行9b0f257の[CI36347414539](https://github.com/daraskme/Nextcloud-flare/actions/runs/36347414539)は全6job成功。今回のpush/CIはgit statusとgh run listで確認します。
