# 開発進捗

更新: 2026-09-27

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

Time Travel候補の`prepare --bookmark`と`verify-bookmark`を追加しました。明示remote・固定account/DBで新しいD1停止tokenを独立照合し、指定UTC時刻へのprovider応答が選択済みbookmarkと一致する場合だけControlDOへ証言を保存します。元challengeから5分の期限を維持し、対象・bookmark・時刻の不一致、取消し、停止更新、時計逆行、保存失敗を拒否します。詳細は[DATABASE_RESTORE_BOOKMARK](DATABASE_RESTORE_BOOKMARK.md)。この記録は復元成功や上書き許可ではありません。

Node42件・workerd24件を追加し、全Node843件と復旧/受付の関連workerd144件が成功しました。named service bindingの全8操作の権限拒否、合成provider応答によるbookmark保存・再起動後再検証・取消し後拒否も成功。型・lint389file・契約/設定・Web build・Worker dry-runも成功しました。詳しい範囲とログは[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。schema0039・通常67table・依存は維持しています。

次はR2 binding照合、R2/KDF/job/repairの終了証明と最終停止、新epoch予約、実D1上書き後の採用・全監査・段階再開です。bookmark照合はローカルの模擬provider応答と実D1/DOで検証したもので、実Cloudflare検索・復元は未検証です。Time Travel/live logical restore、通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開は未完了です。

専用codex/database-restoreで検証済みの区切りをcommitしました。2026-09-27にユーザーが「コミットプッシュして」と明示承認しました。送信先はGitHub daraskme/Nextcloud-flareのcodex/database-restoreです。先行する自動承認レビューによる許可待ちは解消しています。共有main・remote migration・deployは更新していません。今回の全体check・Windows・browser・実CLI backupドリルはローカル再実行していません。直前7b39e93の[CI36153888412](https://github.com/daraskme/Nextcloud-flare/actions/runs/36153888412)はWindowsの一時path短縮名比較で失敗していたため、今回fixtureをrealpathへ正規化しました。最新のpush/CIはgit statusとgh run listで確認します。
