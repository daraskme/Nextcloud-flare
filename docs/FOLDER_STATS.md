# 要求時のフォルダー集計

更新: 2026-09-24。ローカル実装の契約。実D1の処理量・応答時間は未検証。

Filesの「フォルダーの情報」から、現在のフォルダー配下のファイル数・サブフォルダー数・合計サイズを取得する。画面を開くまで集計せず、一覧や検索結果の表示済み件数には依存しない。再集計中・取得失敗時は前の数値を隠す。閉じるとキャッシュを破棄し、フォルダー移動・logout後に古い情報を表示しない。

## APIと認可

`GET /api/v1/stats?scopeId=<folder ID>`。scopeIdを省略するとログイン中のユーザーのspace rootを対象にする。既存の`account.read`契約にscopeRoot operandを明記し、Accessのprivate handlerへ接続する。共有先の集計はこのaccount routeの対象外。app_adminにも他人の集計を許可せず、app password・service・public shareは受け付けない。

返却値は`scopeId, treeGeneration, fileCount, folderCount, totalBytes, scannedNodes, nodeLimit, unavailableFiles, truncated`。未知/重複query・不正scopeIdは400、取得不能・認可失敗は404。成功はprivate, no-storeとnosniffを付ける。署名cursorやR2呼出しは不要。

対象とrootまでのEffectiveLive・現在のAccess credentialを検査し、同じD1 batchで認可proof、所有space、epoch、maintenance、revision/tree generationを再確認して集計する。削除された親の配下や他のowner/spaceのノードは走査しない。

## 集計の意味と上限

- 対象フォルダー自体は件数から除外し、その配下のlive file/folderを数える。
- サイズは現在のblobが同ownerかつcommitted/gc_candidateであるfileごとの合計。copy-on-writeのコピーもそれぞれ計上する。過去version、ごみ箱、予約、physical storageの合計ではない。
- current blobのサイズを確認できないfileは件数に含め、`unavailableFiles`で示す。画面は「集計結果は一部」「確認できた合計サイズ」と表示する。
- 検索と共通の索引付きsuccessor walkを使う。scope自身を含む最大10,000ノード、再帰step最大20,000、space rootからの深さ64。再帰LIMITの前に全siblingを展開しない。
- 10,000ノードに達した場合は保守的に`truncated=true`。深さ64のfolderにさらにlive childが存在する場合も同様。完全に集計できたという表示をしない。件数は最大9,999の配下項目となる。
- schemaの1 blob最大500 GiBと上記の件数上限により、合計はJavaScriptのsafe integer範囲内。返却前にも整数範囲を検査する。
- 永続stats table、migration、依存追加はない。集計や検索の失敗でcontent/ref/会計を変更しない。

## 検証

workerd/D1の12件で、再帰とコピー・空folder・削除祖先・current content不足・所有/共有/credential制限・集計直前の失効/停止/epoch/世代/user無効化・1万件上限・深さ64・HTTP入力を確認する。既存検索9件も共通走査の回帰として実行する。DBのdeleting/ref/depth制約を取り外さずに試験する。

browserでは実APIでupload/MOVE/COPYしたfileを集計し、DELETE後の再集計、desktop/mobile、要求前に集計しないこと、拒否応答後の数値非表示を確認する。部分結果の表示だけは、実APIの成功応答にtruncatedフラグを注入して試験する。全check/browserの最終成否・件数は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。

実CloudflareのD1 rows_read/durationと同時負荷、共有向け集計、media別集計は未検証または未実装。全製品の完了を意味しない。
