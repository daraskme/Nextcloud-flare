# サムネイル変換の実行部

2026-09-29。Galleryのサムネイル生成へ使う内部実行部。`media/images/transform.ts`と`objectStream.ts`を追加した。通常uploadのmetadata確定は[IMAGE_METADATA](IMAGE_METADATA.md)へ接続済みだが、**この変換のQueue接続、費用claim、R2生成物保存・配信、Gallery画面は未接続**。HTTP要求から有料変換を直接実行する経路はまだない。

## 入出力

`planImageTransform`は固定原本のheaderを読み、sm256/md768/lg1600の寸法を決める。小さい画像は拡大せず、EXIF orientationに従って表示軸を決める。入力は20,000,000 bytes・各辺12,000・40MP以下、静止画だけ。巨大入力は読取り前に拒否し、アニメーションAVIF等も変換対象外とする。原本の保存・表示は制限しない。読取り失敗をunsupportedへ変換しない。

`openImageObject`はetag条件付きR2 GETを使い、key・etag・size・全量範囲と実bytesを照合する。native GETが返す範囲情報は、省略かoffset=0かつlength=元sizeだけを許可する。読み取りは64KiB以下で消費者へ渡し、先読みせず、各片の前後で現在認可のcallbackを呼ぶ。EOF時にも長さと認可を確認する。期限後のGET応答、進行中body、利用者取消しを処理する。

`transformImage`はImages bindingを1回だけ呼び、WebP・quality85・anim=falseを指定する。原本の全体bufferやteeは使わない。入力長・chunk数も検査する。生成物だけを最大12MiB・native chunk4,096回・64KiB blockへまとめて検査し、サイズ・寸法・WebP構造・SHA-256を返す。EXIF/XMP/ICC/animation/未知chunkを含む出力は採用しない。alphaは残す。native失敗の自動再送はしない。timeout/cancelはnative処理の終了証明ではない。

## nativeと製品への接続

ローカルR2/ImagesでJPEG・PNG・WebP・静止AVIF/10-bitからの変換、実1920×1080画像の3サイズ縮小、alpha、private camera EXIF除去を検証する。出力を別のImages.infoで読み戻し、原本のbytesも比較する。Cloudflareのoffline実装はproductionと同じcodec/option実装ではなく、EXIF自動回転・色再現・品質・Enterprise AVIF条件の実環境確認は残る。インストール済みMiniflareのbinding fetcherは自動EXIF回転を呼ばず、明示rotate/resize/formatを使うため、寸法試験を向きの実証にしない。

次は次の順に接続する。

1. blob×variant×generatorの費用claimとnative開始/終了/unknown記録。重複Queue、遅い応答、D1復元後の再実行を防ぐ。既存R2 write ledgerはR2操作だけのため、Images変換をR2 PUT成功として記録しない。
2. 生成物の不変key、tracked R2保存、physical容量・終了記録、結果公開のcurrent node/blob/actor/claim/epoch fence、停止・backup・復旧監査。
3. upload Outboxのsm/md生成、lgの要求時生成、thumb ticket/配信、Gallery API/UIと共有閲覧。AVIF入力が実環境で非対応なら原本detailとgrid placeholderへ分岐する。

## 参照

- [Cloudflare Images binding](https://developers.cloudflare.com/images/optimization/binding/): input/output、streamとoffline版の機能差。
- [形式と上限](https://developers.cloudflare.com/images/get-started/limits/): binding入力上限とAVIF入力のplan条件。
- [変換オプション](https://developers.cloudflare.com/images/optimization/features/#metadata): WebPのmetadata除去とEXIF回転。実環境の動作確認を別途行う。
