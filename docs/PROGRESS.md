# 開発進捗

更新: 2026-09-25

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

復旧専用のDatabaseRestoreOperatorと`pnpm database:restore prepare/verify/inspect/cancel`を追加しました。保存したlogical世代の全SQLを隔離SQLiteへ復元し、保存時schema・全table・hash・FK・FTS・凍結状態を検証してから、同じ要求/hashの証言をControlDOに保存します。停止mirror・期限・取消しを保存前に再確認し、再実行でもSQL検証を省略しません。詳細は[DATABASE_RESTORE_OPERATOR](DATABASE_RESTORE_OPERATOR.md)。

全体checkが成功しました。Node762件（42file、47.52s）＋workerd2,180件（103file、1,479.63s）の計2,942件、lint380file・型・契約/設定・Web build・Worker dry-runを確認しました。実service bindingドリルは67table・SQL11,322bytes、実CLIドリルは67table・SQL9,079bytesで成功し、権限拒否、SQL検証・証言保存・再実行・取消し後の停止維持を確認しました。実行記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。schema0039・通常67table・依存は維持しています。

次は対象binding・Time Travel bookmarkの検証、R2/KDF/job/repairの終了証明と最終停止、新epoch予約、実D1上書き後の採用・全監査・段階再開です。sql_verifiedはSQL検証工程の完了で、D1上書き許可ではありません。Time Travel・live logical restore、通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開は未完了です。

作業ブランチcodex/database-restoreは1ac31bfまで通常push済みで、[CI36131132194](https://github.com/daraskme/Nextcloud-flare/actions/runs/36131132194)の全5ジョブが成功しました。今回のCLI追加も検証後に同じ専用ブランチへpushします。共有mainは自動承認レビューの拒否により更新していません。remote migration・deployは未実施です。最新のpush/CIはgit statusとgh run listで確認します。
