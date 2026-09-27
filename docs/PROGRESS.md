# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

epoch履歴の条件付きPUTを[専用の送信・終了記録](EPOCH_HISTORY_WRITES.md)へ接続しました。pending intentとreserved receiptを同時保存し、同じ予約では一度だけPUTします。実応答を失った場合は、GET一致や期限満了でも再送・epoch公開を許可しません。10秒timeout後の実成功は終了記録だけへ反映し、遅延した古い処理はD1採用を進めません。外部CLI保存の[専用記録](BACKUP_PUBLICATION_WRITES.md)と14種類の[共通R2記録](R2_WRITE_SETTLEMENT.md)も接続済みです。

schema0046・通常68table・依存追加なし。新規24ケースを含む関連workerd177件とNode11件、型・lint430file・契約/設定・Web build・Worker dry-run、private binding運用ドリルが成功しました。今回の全体CIはpush後に確認します。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次は復旧要求に固定した新epochの事前予約とD1採用の分離、native結果不明の運用証明を含む全終了確認、実D1上書き後の採用・全監査・段階再開です。現在の凍結だけでD1上書きは開始できません。旧実装や全storage喪失でreceiptがない場合の終了証明、通知先・timer設置、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。先行77623a7の[CI36328691585](https://github.com/daraskme/Nextcloud-flare/actions/runs/36328691585)はUbuntu・Windows分割2・browserの3job成功、backup・Windows分割1は実行中です。3f2217bの[CI36327086181](https://github.com/daraskme/Nextcloud-flare/actions/runs/36327086181)は全5job成功。0dbb5a5のWindows移行fixture失敗は3f2217bで修正済みです。今回のpush/CIはgit statusとgh run listで確認します。
