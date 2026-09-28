# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[所有者間コピーの実行基盤](COPY_JOBS.md)を追加しました。永続受付に加え、同時取得を防ぐ期限付きclaim、owner別上限、保存済み元blobのRange読取りを接続しました。読取り前後で両側の現行権限を再確認し、応答喪失・期限切れ・遅延応答を扱います。転送先への保存・一括公開・取消し/再試行・HTTP/画面は未接続で、所有者間コピー全体は未完成です。

schema0053・通常72table。既存job leaseへinvocationのR2 call数を追加し、以前のtoken・epoch・期限・試行回数を保持します。依存変更はありません。全Node1,376件・関連workerd281件の計1,657件が成功しました。型・lint505file・契約/設定・schema72table/FK graph・Web build/Worker dry-runも成功しました。検証の詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。remote migration/deployは行っていません。

次はcross-owner copy、公開link/password/unlock/public bundle、upload-only、ZIPを進めます。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、未記録処理の終了証拠が不足しており保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

送信先は承認済み専用`codex/database-restore`です。先行33a8a80の[CI36365491865](https://github.com/daraskme/Nextcloud-flare/actions/runs/36365491865)はUbuntu・Windows3分割・browser・backupの全6job成功です。前回の時刻依存テスト修正はWindows3分割でも成功しました。以前のorphan-admission回数不一致と21cd396のR2保存先照合失敗の原因は未確定です。先行af30646の[CI36367826306](https://github.com/daraskme/Nextcloud-flare/actions/runs/36367826306)は最終確認時にUbuntu・Windows1/3と2/3・browser成功、Windows3/3とbackupは実行中です。最新CI状態はgh run listで確認します。
