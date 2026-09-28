# ファイル受け取りリンク

更新: 2026-09-29。schema0066・通常76table・147 route。所有者管理API/画面と匿名の単一・分割送信を接続。実環境の適用・公開は未実施。検証件数と結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)を参照。

## 所有者の管理

Filesでフォルダーの操作から「受け取りリンクを管理」を開く。作成・有効期限・パスワード・同時送信の上限容量・秘密値の再発行・停止に対応する。APIは既存`/api/v1/shares`の`kind:"upload_only"`を使い、所有するfolder/rootのみ受け付ける。入力`reservationLimit`は0以上の安全な整数bytes。UIではMiBで指定する。既存のshare単位の予約会計を使い、上限0ではサイズが正の新規予約を拒否する。空ファイルの受付は可能。

一覧は`GET /api/v1/shares?kind=upload_only&rootNodeId=...`。所有者へ`reservationLimit`と`reservedBytes`を返す。内部共有・閲覧/編集linkのcursorを流用しない。所有者の元Access session、所有権、停止状態、現行versionを確定batchで検査する。kind/rootは変更不可。PATCH/DELETEは`If-Match: "share-<version>"`を要求し、変更時は既存unlock sessionを失効させる。上限引下げや停止は未終了の予約を払い戻さない。URLの秘密値はfragmentだけに含め、再表示しない。

## 匿名側の契約

通常の公開linkと同じunlock challenge、秘密値/password、HttpOnly Cookie、public CSRF、共有/IPの受付制限を使う。`create`と`upload`のみ付与し、原本・一覧・folder作成・名前変更・上書き・削除・operation照会を拒否する。中央node認可でも、共有rootへのuploadを伴うcreate以外を拒否する。

`POST .../uploads`は`mode`, `name`, `declared_size`のみ受け付ける。space/parentは共有から決定し、呼出側によるparent/target/space指定を拒否する。作成、本文/part受信、確定への成功応答は同じ`201 {receipt_id,status_url}`。partが既に処理中なら同じ形の202。作成時の`Upload-Capability`応答headerを、元のCookie・`Share-Session`と合わせて後続要求に使う。capability単独では閲覧・送信・照会できない。

GET statusは当該uploadの状態、サイズ、分割受信記録だけを返す。保存名、既存node、blob、R2 key、private operationを返さず、失敗理由は`upload_failed`へ統一する。未確定応答をoperation IDで匿名側へ開示しない。status_urlも自分のshare/receiptとの完全一致を検証し、任意URLへ追従しない。

元の送信名を第一候補とし、衝突時にはupload由来の96bit文字列と連番を付ける。UTF-8/Unicode名の長さ、拡張子、case foldingを既存portableName規則に合わせる。17候補からlive namespaceに存在しない最初の名前を**公開の原子batch内**で選び、検索index/FTSも確定名で更新する。衝突の有無と最終名は送信者へ返さない。namespace permitや確定時の認可・revision検査は維持する。

## 容量と復旧

所有者とshareの予約を同じD1 batchで取得する。UploadDO/R2許可・status・確定は保存済みpolicy/link/version/session/epochとshare予約を照合する。再送は同じkeyで同じreceipt/capabilityに収束し、予約を重複加算しない。

完了時は両予約を消費する。未送信の単一uploadの中止、native handleの終了が証明された分割uploadの中止、失敗が確定した公開処理では、既存の精算条件に従う。R2 objectが残る失敗ではphysical accountingとGC holdを維持し、lease満了やHTTPエラーだけで払戻しをしない。歴史的なoperation帰属・cleanup・復旧最終監査もupload-onlyに対応する。

migration0066は`uploads.upload_only`を既定0で追加し、旧identityを保持する。share/session/reservationとpolicyの対応を挿入時に検査し、policyの後変更を拒否する。適用条件はmaintenance中、backup/restore freezeなし、open permit/claimed operation/未終了mutation admissionなし。運用DBへはまだ適用していない。

## 画面と再開

匿名画面には送信フォームと自分の未終了記録だけを表示する。IndexedDBへ元のshare/session、送信意図、受付番号、capability、part attemptを保存し、ファイル本体は保存しない。reload後は自動再送せず、結果確認または元fileの再選択を必要とする。作成応答喪失は同じkey、受信済みpartはskip、確定済みstatusは本文/completeを再送せず完了する。完了・停止時にローカルcapabilityを削除し、完了番号を表示する。logout/期限切れと別tab終了の既存処理を維持する。

thumb/page/track、ZIP/media、公開create/rename/deleteのreload後追跡、未知native試行の全閉鎖、大規模・実環境検証は別の残件として維持する。
