# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[受信者のShared画面](SHARED_WORKSPACE.md)にedit共有へのフォルダー作成・改名・単一/分割upload・上書きを追加しました。選択した共有ID/versionをoperation・uploadへ保存し、再送・照会・Outbox・UploadDO・R2書込み・公開確定でも維持します。直接共有したfileの上書きは非共有の親IDを取得せずに実行し、容量は所有者へ計上します。

schema0049・通常69table・依存追加なし。全Node64file/1,325件、全workerd123file/2,691件、全browser27件の計4,043件が成功。lint486file・型・契約/設定・Web build/Worker dry-runとmobile表示も確認済みです。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次はDAV Sharedの固定mount解決・旧NULL mount方針と、共有内の移動・削除を接続します。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、旧実装/全DO喪失に由来する未記録処理の終了証拠が不足しており、保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、公開link/upload-only/ZIP、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

送信先は承認済みGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。先行21cd396の[CI36354864354](https://github.com/daraskme/Nextcloud-flare/actions/runs/36354864354)は5job成功、Windows分割1でR2保存先照合が失敗。再実行でも別ケースの準備中に失敗し、原因切り分けが残っています。今回のpush/CIはgit statusとgh run listで確認します。
