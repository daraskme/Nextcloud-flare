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

単一/分割uploadの新規予約は[共通の更新受付](MUTATION_ADMISSION.md)を必ず通る。所有spaceの32共有枠を取得してから、現在のcredential・node/祖先・上書きrevision・epoch・期限・quotaを再検査し、reservation・staging blob・upload・確定記録・枠解放を同じbatchに保存する。受付不可は503とRetry-After: 1で返し、容量を予約せずR2初期化も開始しない。署名・hash計算は枠取得前に完了する。

同じkey/bodyの保存済み予約の再取得は追加の枠を取らず、現在の認可を検査する読取りとして扱う。batch応答喪失はexactな確定記録で照合する。並行する別要求の保存済みreceiptへ合流することもできるが、それを自分のbatchの成功証明にせず、自分の未確定枠は解放しない。照合が全部失敗した場合も予約・容量を保持し、同じkeyで再照会できる。予約の再取得だけでR2送信を許可せず、後続の初期化/転送は既存の独立したclaim・current authorityを必要とする。

転送の単一PUT開始・読戻し・検証済み情報と、multipart初期化/completeの送信claimも共通受付を通る。外部送信にはclaim batchの直接ACKが必要で、確定記録の読戻しだけでは送信しない。単一PUT後の検証済み情報の受付が混雑した場合は物理容量/予約を保持し、503/Retry-Afterで再試行する。再試行はGET照合でありPUTを再送しない。multipart検証済み情報の保存も共通受付を通り、混雑時は物理容量/予約を保持し、再試行でcompleteを再送しない。physical観測と既知R2 ID・初期化停止・緊急abort予算はsystem受付へ接続済み。UploadDO台帳反映・自動回収の受付統合は後続。

createの同じkey/bodyへの再送は、上書き対象のrevisionが変わった場合も元のreceipt/capabilityを返す。現在の認証・node権限とowner/parent/epochを最終D1 batchで確認し、予約を追加しない。multipartの初期化がrevision変更で停止した場合は202となる。これは状態確認・中止のための回収であり、新規予約、R2初期化、本文送信、確定での旧revision検査を緩めない。対象の移動・失効・期限切れの制限は継続する。

`Upload-Attempt-Id`は`[A-Za-z0-9_-]{1,128}`。同じpart・attemptの再送で新しいR2 callを発行しない。part応答の`disposition`を確認する。

- `completed`: 保存結果を確認済み。同じattemptの再送もこの結果になる。
- `in_flight`: 202。送信結果が未確定で、再送bodyは破棄する。同じattemptの状態を照会し、二重送信しない。
- `not_started`: 200。R2呼出し前の失敗が確定したattempt。再試行には新しいattempt IDが必要。

結果不明のattemptはupload全体を停止する。現在のuploadを再初期化しない。別partへのattempt ID再利用、完成partへの別attempt、停止中の送信は拒否する。4並列の上限は429 + Retry-After、試行/累積budgetや状態競合は409。partごと3試行、data calls/bytesの上限は既存upload台帳が強制する。

GETは確認済みD1のuploadとpartを、同じ権限確認付きbatchで返す。読み取りでDO台帳の再初期化・送信権限の発行は行わない。DOからD1への反映が未確認なら、partは以前の`in_flight`等を示すことがある。再送は保存していた同attempt IDを使い、再照合を台帳に任せる。

multipart receiptには`revision`、`parts`、`nextAfter`を含む。part行は`partNumber,attempts,attemptId,state,expectedBytes,leaseExpiresAt,etag,sha256`。`state`は`pending|in_flight|completed|unknown`で、pendingはR2未開始の結果。GETの既定は`after=0&limit=200`、afterは0〜10,000、limitは1〜200。`nextAfter=null`でその照会時点の末尾。未知query、重複query、不正数値、singleへのpage指定は400、mutationへのqueryは404。ページ間でrevisionやupload状態が変わった場合は先頭から確認し直す。part一覧は公開や再送の許可そのものではない。

期限/idle切れ・中止・回収後も、同じ有効credential・capability・現在のnode権限・epochの下でreceiptを読める。照会は送信期限を延ばさず、失効credential、削除した親、別credential、旧epoch、maintenanceを許可しない。completeの確定済みoperationは同じ現在権限で再照会でき、新しいR2 completeは発行しない。

## 中止と回収

単一/分割の利用者による中止は共通受付を通り、現在の認可・状態と中止記録・確定記録・枠返却を一括保存する。混雑は503/Retry-After: 1。単一は既存のtransfer期限、multipartは期限後も読めるreceiptの制約を維持する。保存済みの中止結果は追加受付なし。単一の予約返却は、batch内でまだwrite attemptがないと確認できた場合だけ行う。

multipart DELETEはD1に`aborting`と送信停止を原子的に保存する。初期化中・既知R2 ID未保存でも中止でき、遅れた初期化結果は回収用の事実としてのみ保存される。すでにcompletingなら409を返し、確定結果を照会する。

202はR2の回収完了ではない。`cleanupPending`を確認する。実行中のlease・結果不明・未知R2 IDがある間は予約容量を保持し、Cron/停止中repairが中止・実在確認を行う。完成物が残っていれば物理容量を計上してGCへ引き渡し、R2不在確認後だけ物理容量を戻す。unknown creation IDの外部inventory修復と実bucketの7日lifecycle確認は残る。

物理観測・既知R2 ID等の後処理は、資格情報失効やメンテナンス後にも必要な事実として共通枠へ記録する。受付失敗時は予約を保持し、未確定の枠を推測で返さない。DB-onlyのACK喪失回収は外部HEAD/abortの送信許可にはならない。内部kindと停止時の契約は[MUTATION_ADMISSION](MUTATION_ADMISSION.md)を参照。
