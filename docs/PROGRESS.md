# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[所有者間コピーの単一保存](COPY_JOBS.md)を追加しました。8 MiB以下のblobを固定sourceから条件付きでコピー先へ保存し、SHA-256・ETag・実容量・native完了記録を照合してcheckpointを進めます。保存済みの応答喪失はPUTを繰り返さず再開し、権限失効やlease解放後の実保存も記録します。大きいblobのmultipart、結果不明/未送信照合、一括公開、取消し・精算、Queue/HTTP/画面は未完成です。

schema0054・通常72table。既存native receiptとcopy保持行を保存してcopy.putと転送情報を追加しました。依存変更はありません。全Node1,381件・関連workerd228件の計1,609件成功（修正後の対象file再実行を含む）。型・lint510file・契約/設定・buildも成功しました。検証の詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。remote migration/deployは行っていません。

次はcross-owner copy、公開link/password/unlock/public bundle、upload-only、ZIPを進めます。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、未記録処理の終了証拠が不足しており保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

送信先は承認済み専用`codex/database-restore`です。先行33a8a80の[CI36365491865](https://github.com/daraskme/Nextcloud-flare/actions/runs/36365491865)はUbuntu・Windows3分割・browser・backupの全6job成功です。前回の時刻依存テスト修正はWindows3分割でも成功しました。以前のorphan-admission回数不一致と21cd396のR2保存先照合失敗の原因は未確定です。先行af30646の[CI36367826306](https://github.com/daraskme/Nextcloud-flare/actions/runs/36367826306)は全6job成功です。先行7e933b1の[CI36369537337](https://github.com/daraskme/Nextcloud-flare/actions/runs/36369537337)は最終確認時にUbuntu・Windows3分割・browser成功、backupは実行中です。最新CI状態はgh run listで確認します。
