# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[multipart中止の実成功記録の回復](MULTIPART_ABORT_RECONCILIATION.md)を追加しました。元abortの9項目のD1 tupleと独立DO履歴を照合し、upload handleを再中止せず回復します。bucketの同じattemptには不変の補足記録を保存し、元のstarted/unconfirmed診断を残します。容量保留と全体閉鎖の条件は維持します。

schema0047・通常69table・依存追加なし。Node全1,277件と最終の関連workerd 5file/198件、型・lint・契約/設定・build、69tableの復旧ドリルが成功しました。既存28methodとCLI引数を維持しています。詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次は未知multipartの全体閉鎖証明と予約/physicalの最終精算、旧backup記録の修復を進める工程です。inventoryの調査・中止コマンドを接続しても、scan/handleのholdを解除するだけで完了にはしません。元abortのD1記録がないsnapshot、導入前の削除済み証拠、全DO storage喪失などのunknownは引き続き保持します。安全な中止、logical import、大規模DBの再開/RTO、終了履歴の実容量/負荷測定も残ります。通知先・timer設置、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。直前9b0f257の[CI36347414539](https://github.com/daraskme/Nextcloud-flare/actions/runs/36347414539)はUbuntu・Windows3分割・browser・backupの全6job成功。先行d50c58bの[CI36345681064](https://github.com/daraskme/Nextcloud-flare/actions/runs/36345681064)は全6job成功。今回のpush/CIはgit statusとgh run listで確認します。
