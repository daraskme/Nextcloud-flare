# アップロード後のサムネイル生成

2026-09-29。`jobs/imageQueue.ts`を通常upload・匿名upload・WebDAV PUTのOutbox consumerへ接続した。画像情報の抽出と同じ原本・親・保存時のactor/credential・claim・epochを使い、sm256とmd768のWebPを生成する。生成済みの[thumb配信](THUMBNAIL_DELIVERY.md)も接続済み。lg1600の要求時生成とGallery画面は後続。

## 通常の処理

検査済みのmetadataを寸法計画に再利用し、headerの追加Rangeを行わない。20,000,000 bytes・各辺12,000・40MP・静止画の制限を満たす画像だけが有料変換へ進む。原本GETはetag条件付きで、streamの各chunkでも現在の認可を再検査する。GET受付とその直後の認可はImages送信前に行い、失敗ならnot_startedとして終了し、次のclaimで再受付できる。Imagesへ渡した後の入力失敗は未確定を保持する。Images成功記録から不変keyへ保存し、実容量・SHA-256・native終了を照合して公開する。

両variantの公開または既知の失敗を確認してから、metadata・判別済み原本MIME・失敗結果・Outbox completedを同じbatchで確定する。画像の公開と元のuploadは別の確定であり、サムネイルが保留でも原本uploadを取り消さない。非画像や後続の上書きに置き換えられた通知は、従来のmetadata処理に従う。

Queue invocation全体で25秒、metadataの2MiB/64 GET、有料変換の試行2回を共有する。原本全量GETは最大2回・合計40,000,000 bytes、出力は1回12MiB以下、同時変換は行わない。異なる通知でも予算を再初期化しない。予算不足はretryし、次の配信で新しいclaimを得る。

## 再配信と中断

有料呼出しの前にblob・variant・generatorの費用記録を読む。succeededは[保存済み公開再開](IMAGE_DERIVATIVES.md)へ進み、追加のImages呼出しやPUTをしない。pendingはretryして保持する。明示的なnot_startedだけは新しい受付が可能で、独立ControlDOの費用キーも再受付時に検査する。元のgrantと保存物を別epochや別通知へ流用しない。

片方だけ保存された状態、両方が公開済みでmetadata確定前に中断した状態から再開できる。元の成功記録・R2 native tuple・予約期限は変更しない。claimの競合、credential失効、原本/親の変更、回収による退役は最終batchでも検査する。

## 非対応と失敗

サイズまたはanimation制限は有料呼出し前に、`derivative_results.failed`・`attempts=0`・`image_unsupported_*`として記録する。画像情報と原本は保持する。nativeが明示的に終了した失敗は費用を保持し、`attempts=1`・`image_transform_failed`を記録する。AVIFの明示的なbinding拒否は`image_unsupported_binding`とする。生のproviderエラーを保存しない。

未知native・保存bytes喪失・preparedの観測欠落では完了を推測しない。これらの修復、明示的な有料再試行予算、lg受付・Gallery API/UIは未完了。失敗した変換をQueue再配信だけで再課金することはない。既存のDLQ/再送経路は維持する。

schema0071・通常79table・147 route、依存・migrationの追加なし。検証結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。ローカルImages/R2/D1/DOの検証であり、実CloudflareのAVIF対応・費用・配備の証明ではない。
