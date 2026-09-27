# 開発進捗

更新: 2026-09-27

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

復旧先BLOBSを照合する`verify-blobs`を追加しました。毎回新しいD1停止tokenを独立照合し、同じ復旧要求へaccount・bucket・jurisdictionを固定します。Workerの固定64-byte probeを新しいnonceへ条件付き更新し、S3経由で一致を確認してからDOへ観測を保存します。共通受付と各D1 batchの停止条件を維持し、取消し・対象変更・応答喪失・時計逆行・25秒超過では成功を返しません。詳細は[DATABASE_RESTORE_BLOBS](DATABASE_RESTORE_BLOBS.md)。

Node40件・workerd26件を追加しました。全Node883件、probe/共通受付の関連workerd106件と、非公開bindingの全9操作の拒否・BLOBS更新・再起動後再検証・取消し後拒否のドリルが成功しました。全体checkも成功し、Node883件＋workerd2,253件の計3,136件、lint394file・型・契約/設定・Web build・Worker dry-runを確認しました。詳しい範囲とログは[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。schema0039・通常67table・依存は維持しています。

次はBACKUPS binding照合、R2/KDF/job/repairの終了証明と最終停止、新epoch予約、実D1上書き後の採用・全監査・段階再開です。今回のS3応答とremote descriptorはローカルfixtureで模擬し、実Cloudflare接続・復旧は実行していません。別コマンドで得た過去のD1/bookmark/BLOBS観測をまとめて上書き許可にはしません。通知先・timer設置、全storage喪失、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

2026-09-27のユーザーの明示承認に従い、送信先はGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。共有main・remote migration・deployは更新しません。直前26d0ef3の[CI36288518080](https://github.com/daraskme/Nextcloud-flare/actions/runs/36288518080)はUbuntu・Windows両分割・backup・browserの全5ジョブが成功しました。最新のpush/CIはgit statusとgh run listで確認します。
