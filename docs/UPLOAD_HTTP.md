# Private upload HTTP

Access user向けの単一・分割upload契約。ControlDO admissionとremote設定はまだ閉じており、実Cloudflare公開は未実施。公開共有のupload routeは別実装で、本契約では有効化しない。

Files画面の確認付き上書きと再開は[UPLOAD_OVERWRITE](UPLOAD_OVERWRITE.md)を参照。

## 認証と入力

全routeはapp origin上で現在のAccess session・credential・node authority・epochを検査する。作成以外は`Upload-Capability`も必要。tokenは同じcredentialとupload identityに束縛し、URLやlogには入れない。

JSON mutationはexact Origin、`Sec-Fetch-Site: same-origin`、`Content-Type: application/json`、`X-CSRF-Token`を要求し、JSONは最大8,192 bytes。binary PUTはexact Origin、既知`Content-Length`、capabilityを使い、JSON/CSRF tokenは不要。既存fileへのPUTには現在のstrong `If-Match: "b-<currentBlobId>"`が必須。length欠落は411、If-Match欠落は428、不一致は412。

| method / path | 入力 | 応答 |
|---|---|---|
| POST `/api/v1/uploads` | `Idempotency-Key`、`{mode,spaceId,parentId,name,declared_size,targetId?,targetRevision?}` | 201 receipt + capability。multipartの初期化結果が未確認/失敗でも追跡できる場合は202 receipt + capability |
| PUT `/api/v1/uploads/:id/content` | single専用。binary、既知length | 200 upload状態 |
| PUT `/api/v1/uploads/:id/parts/:partNumber` | multipart専用。binary、既知length、`Upload-Attempt-Id` | 200 part結果、同attempt処理中は202 + `Retry-After: 1` |
| GET `/api/v1/uploads/:id` | multipartのみ任意`after`/`limit` query | 200 receipt。multipartは最大200件のpart情報を同梱 |
| POST `/api/v1/uploads/:id/complete` | `Idempotency-Key`、`{lockTokens?:string[]}`（最大16件） | 200 committed operation。未確定は503 `commit_unknown` + Retry-After。namespace operationを確保済みならOperation-Idも返す |
| DELETE `/api/v1/uploads/:id` | 空JSON `{}` | multipartは202（中止intent/既存の終端結果）、singleは200。completing/completedは409 |

全応答はprivate/no-store。R2 upload ID、object key、内部credentialは返さない。0 byteはsingleのみ。singleは95,000,000 bytesまで。multipartは最大500 GiB・10,000 parts、固定計画はserverが返す`partBytes`/`partCount`に従う。partNumberは1〜10,000の10進表記で、先頭0は不可。part長さはserverの固定geometryと完全一致する必要がある。

## 再送・状態照会

`Upload-Attempt-Id`は`[A-Za-z0-9_-]{1,128}`。同じpart・attemptの再送で新しいR2 callを発行しない。part応答の`disposition`を確認する。

- `completed`: 保存結果を確認済み。同じattemptの再送もこの結果になる。
- `in_flight`: 202。送信結果が未確定で、再送bodyは破棄する。同じattemptの状態を照会し、二重送信しない。
- `not_started`: 200。R2呼出し前の失敗が確定したattempt。再試行には新しいattempt IDが必要。

結果不明のattemptはupload全体を停止する。現在のuploadを再初期化しない。別partへのattempt ID再利用、完成partへの別attempt、停止中の送信は拒否する。4並列の上限は429 + Retry-After、試行/累積budgetや状態競合は409。partごと3試行、data calls/bytesの上限は既存upload台帳が強制する。

GETは確認済みD1のuploadとpartを、同じ権限確認付きbatchで返す。読み取りでDO台帳の再初期化・送信権限の発行は行わない。DOからD1への反映が未確認なら、partは以前の`in_flight`等を示すことがある。再送は保存していた同attempt IDを使い、再照合を台帳に任せる。

multipart receiptには`revision`、`parts`、`nextAfter`を含む。part行は`partNumber,attempts,attemptId,state,expectedBytes,leaseExpiresAt,etag,sha256`。`state`は`pending|in_flight|completed|unknown`で、pendingはR2未開始の結果。GETの既定は`after=0&limit=200`、afterは0〜10,000、limitは1〜200。`nextAfter=null`でその照会時点の末尾。未知query、重複query、不正数値、singleへのpage指定は400、mutationへのqueryは404。ページ間でrevisionやupload状態が変わった場合は先頭から確認し直す。part一覧は公開や再送の許可そのものではない。

期限/idle切れ・中止・回収後も、同じ有効credential・capability・現在のnode権限・epochの下でreceiptを読める。照会は送信期限を延ばさず、失効credential、削除した親、別credential、旧epoch、maintenanceを許可しない。completeの確定済みoperationは同じ現在権限で再照会でき、新しいR2 completeは発行しない。

## 中止と回収

multipart DELETEはD1に`aborting`と送信停止を原子的に保存する。初期化中・既知R2 ID未保存でも中止でき、遅れた初期化結果は回収用の事実としてのみ保存される。すでにcompletingなら409を返し、確定結果を照会する。

202はR2の回収完了ではない。`cleanupPending`を確認する。実行中のlease・結果不明・未知R2 IDがある間は予約容量を保持し、Cron/停止中repairが中止・実在確認を行う。完成物が残っていれば物理容量を計上してGCへ引き渡し、R2不在確認後だけ物理容量を戻す。unknown creation IDの外部inventory修復と実bucketの7日lifecycle確認は残る。
