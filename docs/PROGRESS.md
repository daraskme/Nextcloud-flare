# 開発進捗

更新: 2026-09-25

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

D1復旧要求の準備・照会・取消しをControlDO内部RPCへ追加しました。選択したlogical世代/hashまたはTime Travel bookmarkをD1の外へ保存し、D1障害・DO再起動・D1のepoch巻き戻りでも停止を保ちます。準備中は受付再開・GC変更・通常backup・別epoch発行を拒否し、D1が閉じた状態のrepairだけを継続できます。取消し後も新しい全監査が必要です。詳細は[DATABASE_RESTORE](DATABASE_RESTORE.md)。

復旧準備28件が成功しました（34.64s）。遅いprimary照会・再開batch・backup開始・epoch発行・重複取消し、未知KDF保留、singleton境界、同epochの古いD1 mirror拒否と未確定停止の再試行を含みます。全体checkも成功し、Node728件（41file、40.16s）とworkerd2,128件（101file、1,300.64s）の計2,856件、lint371file・型・契約/設定・Web build・Worker dry-runを確認しました。結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照してください。schema0039・通常67table・依存は維持しています。

次は世代/対象bindingの信頼確認、R2/KDF/job/repairの終了証明と最終停止、新epoch予約、実D1上書き後の採用・全監査・段階再開です。今回のpreparingはD1上書き許可ではありません。運用CLI・実Time Travel・live logical restoreは未接続です。通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

監視commit ab05fc5のmainへのpushは自動承認レビューに拒否され、個別承認の回答待ちです。mainへのpushを再試行せず、専用のcodex/database-restoreブランチで開発を継続します。専用ブランチへのpushは別途自動承認レビューへ申請します。remote migration・deployは未実施です。
