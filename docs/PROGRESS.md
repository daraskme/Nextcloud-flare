# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[受信者のShared画面](SHARED_WORKSPACE.md)へ、選択した共有内の移動・コピー・ごみ箱移動を接続しました。元と先の両方を同じ共有で検査し、確定済みの再送も共有ID/versionの省略・差替えを拒否します。削除者を記録し、所有者がごみ箱を一覧・復元・完全削除できます。コピー・移動、削除の応答喪失後の再確認と、所有者の復元を実browserで確認しました。

schema0049・通常69table、migration/依存追加なし。全Node64file/1,325件、関連workerd9file/182件、全browser28件の計1,535件が成功。型・lint・契約/設定・Web build/Worker dry-runとmobile表示も確認済みです。今回の全workerd/Windows検査はpush後のCIで確認します。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次はDAV Sharedの固定mount解決・旧NULL mount方針、app passwordの範囲制限を保つ共有操作を接続します。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、旧実装/全DO喪失に由来する未記録処理の終了証拠が不足しており、保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、公開link/upload-only/ZIP、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

送信先は承認済みGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。先行ec0a9ebの[CI36358399164](https://github.com/daraskme/Nextcloud-flare/actions/runs/36358399164)はUbuntu・Windows分割1・browserが成功、Windows分割2/3はbackup-healthの30秒超過で失敗し、backupは確認時点で実行中。今回その複合試験だけWindows実行枠を60秒へ変更しました。先行21cd396のR2保存先照合失敗の原因は別途切り分けが必要です。今回のpush/CIはgit statusとgh run listで確認します。
