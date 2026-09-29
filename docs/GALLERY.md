# Galleryの画像一覧と閲覧

2026-09-29。JPEG/PNG/WebP/AVIFの画像一覧を所有者・内部共有・公開リンクへ接続した。グリッド／リスト、フォルダー直下／再帰、200件ごとの前後ページ、原本ライトボックスと前後移動・矢印キー・Escapeを提供する。[lg要求時生成とプレビュー／原本切り替え](LARGE_THUMBNAILS.md)も接続した。[AV1/Opus情報抽出と動画player](TRACK_METADATA.md)も接続した。動画は静的なプレースホルダーから開き、認可済み原本URLで再生・シークし、未対応端末には原本ダウンロードを提供する。[既存原本の個別情報抽出](MEDIA_EXTRACTION.md)はFilesから要求できる。全原本の自動一括再抽出は後続。

## 一覧と現在の認可

- private: `GET /api/v1/nodes/:nodeId/gallery?recursive=0|1&cursor=...`。内部共有では`shareId`と`shareVersion`を明示する。
- public: `GET /api/v1/public/shares/:shareId/gallery?recursive=0|1&nodeId=...&cursor=...`。`nodeId`省略時は共有root。元の共有Cookieと`Share-Session`を要求し、共有範囲外とupload-onlyを拒否する。

`gallery.read`の集合認可で現在のcredential・share version・root到達性・全祖先の未削除／非表示を検査し、ページSELECTと同じbatchでも再検査する。ユーザーの別所有者の一覧には明示した内部共有が必須。名前や画像情報を親共有から補わない。

画像情報は`node_media.blob_id = nodes.current_blob_id`かつ`image-metadata-v1`、動画情報は現在blobかつ`track-metadata-v1`に限定し、所有者が一致するcommitted/gc_candidate blobの検査済みimage MIMEまたはAV1 codec付きvideo MIMEを返す。撮影日時（なければ更新日時）降順・ID昇順。GPSやraw EXIF/providerエラーは返さない。thumbnailのready/pending/unsupported/failedは現在のsm生成versionのD1記録から表示する。実bytesの取得には別途[サムネイル配信](THUMBNAIL_DELIVERY.md)の完全な検査が必要。

HMACカーソルは専用typeとし、principal/credential・share/version・root/space/owner・epoch・tree generation・画像/動画一覧version・再帰指定・候補上限・末尾sort/idを固定する。有効期限10分。改変、別一覧のtoken、別root/credential/versionへの転用を拒否する。新たに画像情報の抽出が完了した項目は一覧の更新で確認する。

## 候補上限と実測

索引から子・次の兄弟・親を1件ずつ辿り、巨大な直下フォルダーを再帰CTEの待ち行列へ全件投入しない。削除済みの枝を除外し、非表示の枝へ降りない。深さ64・SQL候補上限を強制する。非画像や非表示nodeも走査数に含め、上限到達時は`truncated:true`を返す。ページ内をJSで切っただけの全件走査にはしない。

独立した50,050画像のローカルD1試験では、候補50,000の一覧SELECTが`rows_read=550,203`・154msとなり、設計§15.1の60,000行上限を満たさなかった。設計の縮小条件に従い、通常上限は10,000とする。同じfixtureの10,000候補は110,203行・34ms。この値は一覧SELECTだけで、全認可処理や実Cloudflareのp95測定ではない。50,000 gate合格とは扱わず、将来の最適化後は同じ試験で上限を再判定する。

## ブラウザーと配信

所有者はサイドバーまたは各フォルダーからGalleryを開く。内部共有・公開リンクはファイル一覧から切り替える。表示部品は認証clientをimportせず、各画面が現在の認可に束縛したtransportを渡す。公開bundleの既存のmodule allowlistを拡張しない。

各ページの公開済みsmをまとめて発行し、画面付近の画像だけを同時4件以下で取得する。`Content-Length`があれば照合し、分割転送でも実bytesを数えて12MiB以内に制限する。MIMEはWebP限定。非表示・ページ移動・scope変更・logoutで取得を中断し、object URLを解放する。原本はfetch→Blob化せず、元node/blobに限定したcontent-host URLを`img`へ渡す。private/public CSPのimg-srcはself・固定content origin・検査済みサムネイル用blobに限定する。

変換未対応のAVIFも原本の詳細を開ける。失敗したthumbnailを原本の大量取得へ置き換えない。共有停止後の再読は一覧を消してエラーを表示し、古い応答を保存し直さない。

lg受付を追加した時点はschema0072・通常79table・149 route契約。現在の全体schema・契約数は[CURRENT_STATE](CURRENT_STATE.md)を参照する。検証履歴は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。
