# 開発進捗

更新日: 2026-09-25。製品全体は開発中。remote migration・deployは未実施。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commit f62dad8の[CI36029086734](https://github.com/daraskme/Nextcloud-flare/actions/runs/36029086734)はUbuntu・Windows・browser全成功。Node408/workerd1186/browser19、計1,613件。

## 今回の変更

物理容量の観測、multipartのHEAD予算・既知R2 ID・初期化停止・緊急abort予算を共通受付へ接続しました。復旧用の内部RPCも通常操作・bootstrapと同じ32 active/256 waiting・5秒期限を使います。安定したopen/closed状態のD1 mirrorを確認し、失効・owner無効化・maintenance後の必要な事実を記録できます。

migration0033でsystem/modeを不変にし、通常操作・namespace permitへの流用を拒否します。停止・再開・epoch更新で古い枠を閉じます。DB-onlyの応答喪失はexact receiptで回収し、外部HEAD/abortはclaim batchの直接ACKだけで許可します。結果不明や混雑でも予約容量を推測で返しません。

Node8件/workerd41件を追加。最終的にNode416件/workerd1227件、計1,643件を検証済み。全体実行で見つかった旧期待値2件（物理記録ACK回収・migration数）を修正し、関連39件を再実行して全成功。lint・型・契約・設定・Web build・Worker dry-runも成功。今回のCIはpush後に確認する。 schema0033/通常67table、依存追加なし。詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

- UploadDO台帳・自動回収/GC・Queue等の更新受付とbackup barrier。
- 未知KDF/multipartの全体閉鎖・容量精算、実S3/lifecycle。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの配信・再生。
- backup/restore、実Cloudflare負荷・障害試験、WebDAV実client、公開。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。
