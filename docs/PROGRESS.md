# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[内部共有のWebDAV](DAV_SHARED.md)を接続しました。`/dav/Shared/`に固定mountを一覧し、共有内の読取り・PUT・MKCOL・PROPPATCH・COPY/MOVE/DELETE・LOCK/UNLOCKを扱います。root制限付きapp passwordはSharedを公開せず、資格情報scopeと選択した共有ID/versionを保存・再送・ロック許可・R2送信・Outbox・復旧監査まで維持します。旧NULL mountは推測で補わず、所有者による共有の作り直しでDAV名を付けます。

schema0050・通常69table、依存追加なし。全Node1,338件・関連workerd373件・共有画面browser6件の計1,717件成功。型・lint・契約/設定・buildも成功。検証の詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。remote migration/deployは行っていません。

次は異なる共有間／個人領域とのDAV転送とcross-owner copy、公開link/password/unlock/public bundle、upload-only、ZIPを進めます。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、未記録処理の終了証拠が不足しており保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

送信先は承認済み専用`codex/database-restore`です。先行a9af702の[CI36359614104](https://github.com/daraskme/Nextcloud-flare/actions/runs/36359614104)はUbuntu・Windows分割1/3と3/3・browserが成功。Windows分割2/3は全Node1,325件成功後、orphan-admissionのgc-confirmで886件中1件失敗（受付回数3の期待に対して2）。backupも成功し全6job中5job成功。失敗したWindows分割2/3を同じコミットで再実行中です。productionの期限や検査は緩めていません。先行21cd396のR2保存先照合失敗も原因は未確定です。今回のpush/CIはgit statusとgh run listで確認します。
