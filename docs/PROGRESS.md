# 開発進捗

更新: 2026-09-28

Files基本操作、単一/分割upload、trash/restore/purge、検索、WebDAV、認証・会計・復旧・共通受付、バックアップの停止・生成・R2保存/取得・完了記録と専用運用コマンドをローカル実装済みです。製品全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9です。

復旧要求に固定した[epoch事前予約](DATABASE_RESTORE_EPOCH.md)を内部RPC・private operator・運用CLIへ接続しました。検証済みの復旧元と凍結したD1/BLOBS/BACKUPSを束縛し、DO/R2へ将来の番号を予約します。同じ要求の再実行では番号を変えず、D1の旧epochと凍結を維持します。予約開始後の通常取消し・通常epoch発行・受付再開を拒否し、native結果不明も保持します。実D1上書き後の採用は後続です。

schema0046・通常68table・依存追加なし。新規workerd15ケースを含む関連162件、CLI関連Node126件、型・lint434file・契約/設定・Web build・Worker dry-runが成功しました。全14復旧操作の権限境界と実epoch予約を含むprivate binding運用ドリルも成功。今回の全体CIはpush後に確認します。検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を正とします。

次はnative結果不明の運用証明を含む全終了確認、実D1上書き・snapshot照合・予約epochの採用・全監査・段階再開です。予約後の安全な中止手順も残ります。凍結や予約だけでD1上書きを開始しません。旧実装や全storage喪失時の終了証明、通知先・timer設置、未知multipart、共有/公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実OS client・実環境検証・公開も未完了です。

送信先は承認済みのGitHub daraskme/Nextcloud-flareの専用`codex/database-restore`です。記録時点で5269505の[CI36329896475](https://github.com/daraskme/Nextcloud-flare/actions/runs/36329896475)はUbuntu・browser成功、backup・Windows2分割は実行中。先行77623a7の[CI36328691585](https://github.com/daraskme/Nextcloud-flare/actions/runs/36328691585)と3f2217bのCIは全5job成功済みです。今回のpush/CIはgit statusとgh run listで確認します。
