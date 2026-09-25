# 開発進捗

更新: 2026-09-25

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

復旧準備にControlDO.verifyDatabaseRestoreSourceを接続しました。保存したlogical世代をD1完了記録・R2 manifest・SQL部品のhashへ照合し、1回1部品の検証位置をDOへ保存します。再起動後も続行でき、取消し・古い結果の競合・35日超・検証中の期限超過・時計逆行を拒否します。詳細は[DATABASE_RESTORE_SOURCE](DATABASE_RESTORE_SOURCE.md)。

新規41件（部品/receipt28件・DO/RPC13件）を検証しました。既存の復旧準備と受付再開を含む関連113件（4file、117.56s）が成功し、時計逆行の追加・修正後のDO/RPC13件も成功（8.27s）。lint375file・型・契約/設定・Web build・Worker dry-runも成功しています。直前の復旧準備commit 3b96ea2は全体checkのNode728件＋workerd2,128件、計2,856件が成功済みです。今回の全体CIはpush後に確認します。schema0039・通常67table・依存は維持しています。

次は対象bindingとSQL/schemaの信頼確認、R2/KDF/job/repairの終了証明と最終停止、新epoch予約、実D1上書き後の採用・全監査・段階再開です。parts_verifiedはSQL検証完了やD1上書き許可ではありません。運用CLI・Time Travel・live logical restoreは未接続です。通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

作業ブランチはcodex/database-restoreです。検証済みcommitをこの専用ブランチへ通常pushし、CIを確認します。共有mainへの更新は自動承認レビューに拒否され、ab05fc5の個別承認待ちを維持しています。remote migration・deployは未実施です。
