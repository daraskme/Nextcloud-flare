# 開発進捗

更新: 2026-09-25

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

復旧準備にControlDO.verifyDatabaseRestoreSourceを接続しました。保存したlogical世代をD1完了記録・R2 manifest・SQL部品のhashへ照合し、1回1部品の検証位置をDOへ保存します。再起動後も続行でき、取消し・古い結果の競合・35日超・検証中の期限超過・時計逆行を拒否します。詳細は[DATABASE_RESTORE_SOURCE](DATABASE_RESTORE_SOURCE.md)。

復旧元照合は新規42件（部品/receipt28件・DO/RPC14件）を検証しました。da90db7までの関連114件に加え、完了後の再照会が競合すると新しい検証時刻を上書きできる不具合を再現・修正し、DO/RPC全14件（9.02s）とlint375file・型検査が成功しました。先行版の契約/設定・Web build・Worker dry-run、3b96ea2の全体check（Node728件＋workerd2,128件）も成功済みです。da90db7の[CI36130676778](https://github.com/daraskme/Nextcloud-flare/actions/runs/36130676778)はbrowser成功・残り実行中で、追加修正の全体CIは別実行で確認します。schema0039・通常67table・依存は維持しています。

次は対象bindingとSQL/schemaの信頼確認、R2/KDF/job/repairの終了証明と最終停止、新epoch予約、実D1上書き後の採用・全監査・段階再開です。parts_verifiedはSQL検証完了やD1上書き許可ではありません。運用CLI・Time Travel・live logical restoreは未接続です。通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

作業ブランチcodex/database-restoreを公開し、ab05fc5・3b96ea2・da90db7の3commitを通常pushしました。追加修正も同じ専用ブランチへpushします。共有mainへの更新は自動承認レビューに拒否されたため行っていません。remote migration・deployは未実施です。最新のpush/CIはgit statusとgh run listで確認します。
