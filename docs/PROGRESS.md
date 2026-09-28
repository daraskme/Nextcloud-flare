# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[所有者間コピーの準備](COPY_JOBS.md)を実装しました。コピー元と上書き対象の構成・blob・属性を固定し、両側の権限と変更の有無を開始確定のbatchで再検査します。COW aliasは実体ごとにまとめ、コピー元pinと転送先の容量予約を原子的に取得します。永続job・Queue・R2転送・一括公開・取消し/再試行・画面はこれから接続するため、所有者間コピー全体は未完成です。

schema0051・通常69table、schema/依存追加なし。全Node1,361件・関連workerd130件の計1,491件成功。型・lint・契約/設定・buildも成功。検証の詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。remote migration/deployは行っていません。

次はcross-owner copy、公開link/password/unlock/public bundle、upload-only、ZIPを進めます。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、未記録処理の終了証拠が不足しており保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

送信先は承認済み専用`codex/database-restore`です。先行8dbdcc6の[CI36363511416](https://github.com/daraskme/Nextcloud-flare/actions/runs/36363511416)はWindows分割3/3の全Node1,361件中1件が失敗。r2-write-schemaのpending作成が、秒単位時計の境界でdispatch期限不足として拒否されました。SQLiteの実triggerを使う試験用時計を固定し、期限経過を明示的に進める形へ修正。productionの期限や検査は変更していません。先行f953d43のCI全6job成功、a9af702も再実行後全6job成功です。以前のorphan-admission回数不一致と21cd396のR2保存先照合失敗の原因は未確定です。最新CI状態はgh run listで確認します。
