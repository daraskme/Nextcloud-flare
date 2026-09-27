# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

[復元後のupload・予約・outbox修復](DATABASE_RESTORE_DOMAINS.md)をprivate operatorとCLIへ接続しました。`repair-restored`から4種類を1回最大20件ずつ処理します。multipartの実中止後にDB更新だけ失敗した場合は、元のR2記録とDO履歴を照合して閉鎖記録を補い、再中止せず精算できます。証拠が不足する対象の容量と元tokenは保持し、修復前後の停止・全監査を維持します。

schema0046・通常68table・依存追加なし。今回の関連テストはNode112件と、再実行を含むworkerd7file/190件で計302件成功（新規49件）。型・lint463file・契約/設定・Web build・Worker dry-runも成功しました。運用通し試験とCIを含む検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次はmultipart inventory・全bucketの未知handle・orphan/GC・旧backup記録の修復を、同じ復旧要求へ固定した運用経路へ接続する工程です。元abortのD1記録がないsnapshot、導入前の削除済み証拠、全DO storage喪失などのunknownは引き続き保持します。安全な中止、logical import、大規模DBの再開/RTO、終了履歴の実容量/負荷測定も残ります。通知先・timer設置、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。直前981ae36の[CI36342685456](https://github.com/daraskme/Nextcloud-flare/actions/runs/36342685456)はUbuntu・Windows3分割・backup・browserの全6job成功。先行daa143eの[CI36341055303](https://github.com/daraskme/Nextcloud-flare/actions/runs/36341055303)も全6job成功。今回のpush/CIはgit statusとgh run listで確認します。
