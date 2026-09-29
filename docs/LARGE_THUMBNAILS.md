# 大きいプレビューの要求時生成

2026-09-29。Galleryの詳細表示からlg1600 WebPを要求し、Queueで生成・保存・公開する。所有者・明示した内部共有・匿名の公開リンクに対応する。HTTPでは受付と状態照会だけを行い、GET/HEADで有料変換しない。

## 受付と一意性

privateは`POST /api/v1/nodes/:nodeId/thumb`、publicは`POST /api/v1/public/shares/:shareId/thumb/:nodeId`。同一origin、現在のAccessまたは共有Cookie/Share-Session、CSRF、Idempotency-Keyを必須とする。画像には8KiB以下のJSONで`{blobId,variant:'lg',share?}`を受ける。現在の音声metadataがある原本は`variant:'sm'`で[埋め込み表紙](AUDIO_COVERS.md)を要求できる。`share`は内部共有の明示選択用。クライアント生成画像や任意のgenerator・R2 keyを受け取らない。

現在の`gallery.read`認可、全祖先の非表示／削除、固定node/parent/blob、検査済みの画像metadata generator、所有spaceを受付batchで照合する。読み取り権限の`thumbnail.request` operationと`image.requested` Outboxを一括保存する。namespace permitは受付だけに使い、Queue送信前に返す。画像変換やR2保存中は保持しない。

通知ID・payloadは原本blob、lg、image-webp-v1の配列のSHA-256を使う。0072の部分一意索引と既存の費用記録により、別名ファイルや別閲覧者からの要求も同じ生成物へ集約する。受付応答喪失でも同じ要求の確定記録を確認する。返す状態はpending（202）／ready／unsupported／failed（200）で、すべてno-store。

## Queue・現在の閲覧権限

元アップロードの資格情報とは独立に、要求を受け付けた閲覧者のcredentialと選択した共有versionを保存する。Queue claim、原本の各Range/chunk、native grant、PUTと公開直前、通知完了で現在の認可・固定原本・claim・epochを再検査する。元uploadの資格情報が失効しても、現在の閲覧者による要求は処理できる。

既存の[画像費用記録](IMAGE_COSTS.md)、[生成物保存と公開再開](IMAGE_DERIVATIVES.md)、[Queue予算](IMAGE_QUEUE.md)を再利用する。同一invocation全体で有料試行2回・25秒を共有し、lgだけを生成する。元画像ヘッダーの読取りにも共有の2MiB・64 GET上限を適用する。保存済み出力は新しいclaimで公開を再開でき、変換・PUT・容量計上を重複させない。

## Gallery

開いた画像1件だけにプレビューを要求する。生成中・非対応・失敗・受付エラーなら、現在の原本のcontent URLを表示する。生成完了後は開き直すか「軽いプレビューを表示」でlgへ切り替えられる。自動ポーリングは行わない。「原本を表示」は直接content URLへ切り替える。

lg配信は既存の[サムネイルチケットと配信](THUMBNAIL_DELIVERY.md)を通し、現在の元node/blob・公開世代・共有状態・容量を確認する。WebPを実bytesで12MiB以内に制限し、詳細を閉じる・切り替える・logoutで取得を中断してobject URLを返す。原本はfetch→Blob化しない。公開bundleのmodule allowlistを拡張しない。

## 残件と移行

受付後に保存された閲覧者の資格情報が失効したjobを、別閲覧者へ自動的に付け替えない。同じ通知はretry/DLQへ進み、後続の要求は保留状態を返す。この場合も原本を閲覧できる。未知nativeの運用上の解決、失われた生成bytesの再変換、明示的な有料再試行と古い要求の安全な再受付は後続。

schema0072・通常79table・149 API route。migrationはoperation catalogueとOutbox部分一意索引だけを追加する。停止・未凍結・未終了permit/operation/admission/nativeなしで適用する。旧Workerへのrollbackも停止を維持して対応schema/コードを再検証する。依存追加なし。ローカル検証の正本は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。実Cloudflareの費用・codec・配備を証明するものではない。
