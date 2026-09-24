# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commit8892b4fはmainへプッシュ済み。[CI36034974068](https://github.com/daraskme/Nextcloud-flare/actions/runs/36034974068)はUbuntu・Windows・browser全成功。Node416/workerd1260/browser19、計1,695件。

## 今回の変更

単一・分割アップロードの自動回収を共通の復旧用受付へ接続しました。停止claim、HEAD/abort予算、物理観測、既知handleの閉鎖、容量精算・GC引渡し、エラー記録が通常操作と同じ32 active/256 waiting枠を使います。

停止claimは正確なcleanup tokenで回収できますが、外部HEAD/abortは予算batchの直接ACKが必要です。確定済みDB記録はexact receiptで照合し、他の回収処理の終端記録で自分の未確定枠を返しません。待機・遅いACKで実行時間を超えた場合は外部送信を止め、予約・leaseを保持します。ControlDO内の復旧は同じinstanceの受付を直接使い、自己RPCや別枠を作りません。

workerd62件追加（回収境界56件・実ControlDO共有枠6件）。最終対象100件が成功。全体pnpm checkも成功し、Node416/25files（5.32秒）・workerd1322/71files（672.25秒）、計1,738件、lint・型・契約・設定・Web build・Worker dry-runが通過。今回のCIはpush後に確認する。schema0033/通常67table、migration・依存追加なし。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

GC・残るinventory/Queueの更新受付とbackup barrier、未知KDF/multipartの収束、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
