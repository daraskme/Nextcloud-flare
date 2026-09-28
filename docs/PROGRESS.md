# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[内部共有のWebDAV](DAV_SHARED.md)で、同じ所有者の異なるmount間のCOPY/MOVEと上書きに対応しました。転送元と転送先のshare ID/versionを別々に保存し、再送・ロック許可・結果照会・Outbox・復旧監査まで引き継ぎます。COPYは転送元readと転送先edit、MOVEは両側editを要求し、停止した共有を別の広い共有で補いません。所有者をまたぐCOPYは非同期jobが後続で、cross-space MOVEは非対応です。

schema0051・通常69table、依存追加なし。全Node1,361件・関連workerd339件・共有画面browser6件の計1,706件成功。型・lint・契約/設定・buildも成功。検証の詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。remote migration/deployは行っていません。

次はcross-owner copy、公開link/password/unlock/public bundle、upload-only、ZIPを進めます。復旧側の未知multipart全体閉鎖・予約/physical最終精算は、未記録処理の終了証拠が不足しており保留を維持します。旧backup修復、安全な中止、logical import、大規模DB/RTO・終了履歴の容量測定、通知/timer設置、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・staging・公開も残っています。

送信先は承認済み専用`codex/database-restore`です。先行f953d43の[CI36361608147](https://github.com/daraskme/Nextcloud-flare/actions/runs/36361608147)はUbuntu・Windows3分割・browser・backupの全6job成功。a9af702の[CI36359614104](https://github.com/daraskme/Nextcloud-flare/actions/runs/36359614104)も失敗jobの再実行後に全6job成功しました。初回Windows分割2/3のorphan-admission受付回数不一致と、先行21cd396のR2保存先照合失敗の原因は未確定です。productionの期限や検査は緩めていません。今回のpush/CIはgit statusとgh run listで確認します。
