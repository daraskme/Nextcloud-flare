# 既存ファイルのメディア情報抽出

所有者・内部共有・公開リンクのファイル画面から「メディア情報を読み込む」を要求する。音声metadataが欠けてAudio一覧に出ない古い原本や、metadataを引き継がなかったコピー先も対象にできる。画像・動画も新しいuploadと同じbounded parserを使う。拡張子や利用者申告MIMEだけで形式を決めない。

## 受付と処理

privateは`POST /api/v1/nodes/:nodeId/media`、publicは`POST /api/v1/public/shares/:shareId/media/:nodeId`。bodyは`{blobId,share?}`、CSRF・Idempotency-Keyと現在のAccess/Share-Sessionを必要とする。内部共有は選択したshare ID/versionを固定する。read権限で要求でき、受け取り専用共有は対象外。

`media.extract` operationと`media.requested` Outboxを同時に保存し、短いnamespace permitを返してからQueueへ送る。node/blob/`media-metadata-v1`の固定IDを使い、同じnodeの同じ原本への要求を集約する。COWで別nodeにしたものは、それぞれのタグと索引を更新する必要があるため別要求になる。

consumerは元uploadのactorを使わず、受付時に保存した現在の読者を再認可する。全祖先の可視性、選択共有、node/parent/blob、R2 key/size/etag、epochとclaimをRange前後と確定時に照合する。R2読み取りはinvocationで4MiB/128回、処理期限25秒を共有する。原本を書き換えず、有料Images変換を呼ばない。表紙はAudioに表示された後の[表紙要求](AUDIO_COVERS.md)、画像lgは[プレビュー要求](LARGE_THUMBNAILS.md)を使う。

対応する情報を読み取れた場合、MIME・node_media・node_audio・実効タグの検索cache/base/FTS・一覧世代・Outbox終端結果を同時に確定する。同じblobの利用者overrideを保持し、snapshotに対する同時編集は全体を巻き戻す。名前/revision変更や未来の検索revisionも再検査する。原本、node revision、再生位置、参照/容量は変更しない。

読み取り範囲内で未対応の場合は、既存のmetadataを保持して`unsupported`の結果だけ保存する。予算切れ、権限失効、原本変更、DB/R2障害は未対応と確定しない。完了結果はOutboxに保存し、応答喪失・reload・別keyからの確認でも原本を再走査しない。

## 画面と移行

受付後は「状態を確認」で明示的に照会する。自動pollは行わない。完了するとAudioまたはGalleryへ反映されたことを知らせる。表示を閉じた後やlogout後の遅い応答は破棄する。

0076はoperation catalogue、Outboxの上限付き終端JSON列、`media.requested`部分一意索引を追加する。通常79tableを維持し、API routeは151となる。停止・backup/restore未凍結・未終了permit/operation/admission/R2/KDF/Imagesなしで適用する。既存migrationを変更しない。実Cloudflareへの適用は行っていない。

## 残件

これは現在読めるファイルへの明示要求であり、全原本を自動走査する一括再抽出は後続。受付済み要求の読者失効・parent変更・DLQ等は、既存の認可確認付き再送と保留契約に従い、別読者へ自動付替えしない。同じ抽出versionでの完了後の強制再走査、未対応parser領域、他OS/browserと実Cloudflare gateも後続。試験結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)へ記録する。
