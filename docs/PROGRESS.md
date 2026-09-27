# 開発進捗

更新: 2026-09-27

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

D1の書き込み凍結を追加しました。freshなD1/BLOBS/BACKUPS照合後、DOにintentを保存して修復の新規受付を閉じ、migration0040で全67通常tableの更新を拒否します。再起動・応答喪失後は同じ要求を再照会でき、取消しは停止revision/tokenを更新して遅れた凍結を拒否します。詳細は[DATABASE_RESTORE_FREEZE](DATABASE_RESTORE_FREEZE.md)。

Node24件・workerd31件を追加しました。関連Node66件とworkerd31件、全13操作の権限拒否・保留予約による拒否・凍結・再起動・取消しの非公開bindingドリルが成功しました。全体checkが成功し、Node949件＋workerd2,312件の計3,261件、lint405file・型・契約/設定検査・Web build・Worker dry-runを確認しました。schema0040・通常67table・依存追加なし。実行記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

次は外部I/Oの送信・終了記録を補い、R2/KDF/job/repairの全終了を証明する最終停止、新epoch予約、実D1上書き後の採用・全監査・段階再開です。空ファイルPUTやtarget manifestの保存/削除には最終停止へ集約する記録が不足しています。現在の凍結はD1の書込み障壁で、全外部処理の終了や上書き許可は与えません。実Cloudflare接続・復旧は未検証です。通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。共有main・remote migration・deployは更新しません。直前8a220e7の[CI36309001925](https://github.com/daraskme/Nextcloud-flare/actions/runs/36309001925)はUbuntu・Windows両分割・backup・browserの全5ジョブが成功しました。最新のpush/CIはgit statusとgh run listで確認します。
