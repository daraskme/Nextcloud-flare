# 開発進捗

更新: 2026-09-26

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

復旧先D1を照合する`pnpm database:restore verify-d1`を追加しました。対象mode・DB UUID・remote accountをControlDOへ固定し、新しい停止tokenをCLIの独立queryとWorker側の再読取りで照合します。観測は5分以内に限定し、別DB・古いtoken・取消し・期限・時計逆行・保存失敗を拒否します。再実行でも新しいchallengeとqueryを使います。詳細は[DATABASE_RESTORE_TARGET](DATABASE_RESTORE_TARGET.md)。既存の隔離SQL検証は[DATABASE_RESTORE_OPERATOR](DATABASE_RESTORE_OPERATOR.md)を参照してください。

今回の全Node801件と復旧/受付の関連workerd120件（重複を除く）が成功しました。Node39件・workerd23件を追加しています。実named service bindingで全7操作の権限拒否・D1照合・再起動後の再実行を確認し、既存の隔離local fixtureを使った実CLIでも照合・再実行・誤DB拒否・取消し後拒否を確認しました。型・lint385file・契約/設定・Web build・Worker dry-runも成功。詳しい範囲とログは[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。schema0039・通常67table・依存は維持しています。

次はR2 binding・Time Travel bookmarkの検証、R2/KDF/job/repairの終了証明と最終停止、新epoch予約、実D1上書き後の採用・全監査・段階再開です。d1_verifiedとsql_verifiedは各工程の観測/検証で、D1上書き許可ではありません。Time Travel・live logical restore、通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開は未完了です。

先行1285adfは専用codex/database-restoreへpush済みで、[CI36134958172](https://github.com/daraskme/Nextcloud-flare/actions/runs/36134958172)の全5ジョブが成功しました。今回のD1照合を区切りとして同じ専用ブランチへcommit/pushします。共有main・remote migration・deployは更新していません。最新のpush/CIはgit statusとgh run listで確認します。
