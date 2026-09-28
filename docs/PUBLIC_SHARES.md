# 公開リンク共有

更新: 2026-09-29。schema0065・通常76table・147 route。所有者管理API/画面、匿名unlock/logout/CSRF、独立公開画面・一覧・content ticketと公開GET/HEADによる原本配信、公開フォルダー作成・名前変更・ごみ箱への移動と権限切替、公開upload/overwrite APIと再開可能な画面を接続済み。upload-only・thumb・ZIP・media、実環境の共有は未完了。

## 所有者による管理

Filesのファイル・フォルダー操作メニューから「公開リンクを管理」を開く。新規は閲覧を初期選択とし、閲覧/編集の権限、期限と任意のpasswordを設定できる。設定変更でも現在のroleを初期表示して切り替えられる。編集権限は共有内容の変更を許可する設定で、現在の公開画面ではフォルダー作成・名前変更・アップロード・上書き・ごみ箱への移動に対応する。作成・再発行の応答に含まれるURLはcomponent内だけに保持し、clipboardへのコピーと公開画面を開く操作を提供する。storage・query cacheへ保存せず、dialogを閉じると再表示できない。設定変更はpasswordの維持/新規設定/解除を区別し、期限切れは期限を更新してから再発行する。

再発行・停止は旧URLと閲覧sessionの失効を画面内で説明し、対象操作を確認する。結果不明とversion競合では更新操作を無効化し、一覧更新後に最新のリンクを選び直す。POST/PATCHを自動で再送せず、受け取れなかった秘密値は再発行で取得する。secretを一覧から復元したように表示しない。独立したlink一覧queryを使い、内部共有の操作は従来どおり利用できる。

既存のAccess/CSRF付き`POST /api/v1/shares`は`kind:"link"`、`rootNodeId`、`role:"read"|"edit"`、任意の`expiresAt`と`password`を受ける。所有している現行root/subtreeだけを対象にする。内部共有の受信者や別の管理者に再共有の権限は与えない。パスワード計算の前後と確定batchで、元のAccess credential、所有者、祖先、epoch、maintenanceを検査する。

201には`id`、`version`、32-byte乱数の`secret`を一度だけ返す。URLは`/s/<id>#<secret>`で公開画面へ接続する。DBにはshare IDと用途に束縛したSHA-256 digestだけを保存し、平文secret・passwordを保存しない。GET/detail/listからsecret・digest・salt・KDF情報を返さない。

`GET /api/v1/shares?kind=link`と任意の`rootNodeId`は所有リンクだけを最大100件のkeysetで返す。cursorは用途、root、actor、credential、epochへ束縛する。内部共有と公開リンクのcursorを交換できない。期限切れリンクは所有者が確認・変更でき、無効化済み・祖先がtrashのリンクは隠す。`GET /api/v1/shares/:id`は現行所有者だけが公開リンクの設定を確認できる。既存の内部共有・受信共有の動作を維持する。

PATCHは`If-Match: "share-<version>"`を必須とし、root/kindを変更しない。password省略は保持、nullは削除、文字列は置換。`rotateSecret:true`は新しいsecretを生成し、その応答だけに返す。設定変更・秘密値更新・停止はversionを進め、share sessionと派生content session/ticketを同じbatchで失効させる。既存budgetの使用量や容量保持は変更しない。DELETEも同じversionと所有者認可を要求する。

作成・更新は共通mutation admissionへ接続する。D1の受付receiptで確定が確認できれば応答を回収できる。receipt照会まで失敗した場合は503を返し、自動でPOSTを繰り返さない。所有者は一覧で作成・version変更の有無を確認し、必要ならそのリンクの新しいversionを使ってsecretを更新する。失われたsecretは再表示できない。

## パスワード

UTF-8で1〜1,024bytes、入力を正規化・trimしない。不正なUnicode surrogateを拒否する。share IDと用途を含む入力を専用HMAC鍵で処理し、16-byte salt、PBKDF2-HMAC-SHA256 100,000回、32-byte出力を使用する。recordはdigest/salt/kdf/canonical params/kidを保存する。

新しい設定は`SHARE_PASSWORD_KEYS`と`SHARE_PASSWORD_ACTIVE_KID`。1〜3個の32-byte鍵を読み、active kidで新規保存する。app passwordやCookieの鍵を使い回さない。実行は既存のisolate内KDF制限とControlDOのglobal KDFへ渡す。公開側の照合helperは旧kidを含むringで読めるが、未知kidを受け付けず、KDFの混雑・不明結果をpassword不一致へ変換しない。remote secretは設定していない。

## 匿名認証

`POST /api/v1/public/shares/:id/unlock`は同じ経路で二段階の受付を行う。両段階ともexact Origin、Sec-Fetch-Site same-origin、8KiB/5秒以内のJSONを必須とする。最初の`{"step":"challenge"}`は共有の有無や設定を開示せず、5分の署名challengeを本文と`__Host-ncf_unlock_<id>` Cookieへ返す。既存の有効なchallengeを再利用する。CookieはSecure/HttpOnly/SameSite=Lax/Path=/。続く`{secret,password?}`はそのCookieと完全一致するX-CSRF-Tokenを必須とし、署名・share ID・epoch・origin・期限を検証する。このpre-unlock challengeは、R6の認証後CSRF発行APIとは別の用途である。

既存の有効な共有Cookieがあれば、challenge要求には認証済みのroot ID/version/期限だけを返し、KDFやsession作成を繰り返さない。新規認証は秘密値、必要ならpasswordを検証し、所有者・共有設定・root/祖先・epoch・停止状態をsessionとcredentialの登録batchで再検査する。Cookie署名鍵は専用`SHARE_COOKIE_KEYS`/`SHARE_COOKIE_ACTIVE_KID`。Access設定やprivate CSRF鍵は公開認証に不要で、用途違いのtokenを受け付けない。

署名は正しいが現行sessionが失効済みの場合、そのsessionと同じnonceのchallengeは新しく発行する。すでに別nonceへ進んだchallengeは維持するため、古い共有Cookieが残ったまま新しいunlockの応答が失われても、同じcredentialへ収束する。失効済みcredentialは復活させない。

認証済みCookieは`__Host-ncf_share_<id>`、Secure/HttpOnly/SameSite=Lax/Path=/、最長7日かつshare期限以内。share/version/session/epoch/origin/iat/exp/nonceを署名する。D1にはnonceの用途別digestだけを保存し、同じchallengeから同じsession IDを導く。並行送信、batch ACK喪失、receipt照会失敗後も同じchallengeを使って再試行でき、二つ目のcredentialを作らない。有効なsessionの期限を延長せず、失効済みの行を復活させない。challenge喪失・期限切れ後の同一性は保証しない。ブラウザーの初回同時タブとCookie共有はpublic UIのE2Eでも検証した。

`POST /api/v1/public/shares/:id/csrf`は本文なし、exact Origin/same-originと現行共有Cookieを必須とし、既存のpublic用CSRF（1時間・再使用/再発行可）を返す。logoutはそのCSRFと空JSON objectを要求し、当該unlock credentialのshare session、派生content session、ticketを同じbatchで失効させる。他の匿名閲覧者やbudgetの使用量は変更しない。成功時に共有Cookieとchallenge Cookieを削除する。共有のversion更新/失効・owner停止・祖先trash・期限・epoch不一致後は既存Cookieを受け付けない。

## 試行回数

edge limiterに加え、ControlDOの`admitShareUnlock`がrolling 60秒で共有10回・client IP30回を一括で計上する。信頼済みCF-Connecting-IPだけを使い、IPv6表記を正規化する。productionでIPが得られない場合は503とし、developmentだけloopbackを使う。raw IPはDOへ永続保存せず、DO内の独立した乱数saltによるHMACをkeyに使う。

rate ledgerはDO SQLiteへ保存し、eviction・epoch変更で使用量を消さない。最大4,096key、keyごと最大30時刻と期限indexで容量を制限し、満杯は429。状態が初めて作られた場合や全喪失後は60秒待機する。時計の逆行、停止、D1 mirror不一致、RPCの結果不明は拒否する。失敗した認証の回数は返金せず、RPCを自動再送せず、KDFへ先に進まない。KDFそのものは既存のglobal/isolate制限へ接続する。rate ledgerはD1 backup対象ではなく、喪失時の待機で再開する。

## 公開閲覧と配信

`GET /api/v1/public/shares/:id`と`GET .../:id/children/:nodeId`は現行共有Cookieとsame-originのFetch Metadataを必須にする。rootの親IDをnullにし、root DTOからowner/spaceを除く。共有の上位階層・外部nodeへのアクセスを拒否し、認可とメタデータ読取りを同じD1 batchで再検査する。子一覧は最大200件で、署名cursorをshare/version・匿名credential・epoch・tree generationへ束縛する。private cursorや別匿名sessionのcursorへ差し替えられない。

public CSRF付き`POST .../:id/tickets`と`POST .../:id/content-session`はnodeIds（最大1,000件）とttlSeconds（1〜600秒）を受ける。spaceと共有はCookieから決定し、用途をcontentに固定、期限をunlock期限以内に切り詰める。既存のtarget manifest・R2実体検査・共通mutation admissionを通して発行する。content hostの`POST /session`でCookieへ交換し、`GET/HEAD /c/:nodeId/:blobId`へ接続する。すべての配信は既存の現行認可とBudgetDOを通し、同じunlock credentialからの発行で`s:<shareId>:c:<unlockId>`の予算を再利用する。public CSRF付き`DELETE .../:id/tickets/:ticketId`も接続し、取消しで予算を消さない。DELETEにもapplication/json Content-Typeを要求する。

`/s/:id`は共有の存在に関係なく一般的な画面だけを返す。公開JS/CSSはprivateとは別のVite buildで、public source・React runtimeだけを許可する。private/auth/test/server module、環境変数埋込み、dangerouslySetInnerHTML、service workerをビルド時に拒否する。生成manifestはexact path・auth:public・SHA-384・bytesを保持し、landingのscript/linkへSRIとcrossorigin=anonymousを付ける。Workerは静的配布物の長さとhashを照合後に返し、欠損・改変は503。CSPはinline script/styleを許可せず、content hostへの接続だけを追加する。

画面はfragmentを読み込み直後にhistoryから除去し、秘密値をメモリーだけに保持する。unlock成功で破棄し、名前はReactのtext nodeへ表示する。Web Locksで同一shareの初回challenge/認証をタブ間で直列化し、有効なCookieがあれば再利用する。password入力、429のRetry-After表示、フォルダー移動、追加ページ、ファイルの表示・保存、Cookieによるreloadに対応する。共有を閉じた後はBroadcastChannelで同じshareの他タブも消去する。Web Locksがない環境では新規認証を開始しない。異なるtargetを同時に開く場合のcontent host共通Cookieの競合と、実ブラウザー/Access Bypass設定は引き続き実環境で確認する。

同じタブで末尾だけが異なるURLを開く場合、ブラウザーはdocumentを再読込みしないことがある。hashchangeでもfragmentを消去し、進行中の旧clientを中止してpassword・root・一覧を新しいcomponentへ切り替える。再発行前後のリンクを開き直す際も、古い認証表示を流用しない。

## 公開APIからの原本GET/HEAD

`POST .../:id/content-session`に`{nodeIds,ttlSeconds,delivery:"app"}`を指定すると、現在のpublic CSRFと元の`Share-Session`を検査し、既存のtarget manifest・ticket・D1 content sessionを発行する。応答は`{sessionId,ticketId,targetSetId,budgetId,expiresAt}`で、署名ticketや署名Cookieを返さず、app hostにcontent host用Cookieを設定しない。`delivery`省略時は従来どおりcontent hostへ交換するticketを返す。`/tickets`ではこの追加指定を受け付けない。

`GET/HEAD .../:id/content/:nodeId`は、現行共有Cookie・元の`Share-Session`と、上のIDを指定する`Content-Session`ヘッダーが必要。IDは配信対象を選ぶための値で、それだけでは認証できない。queryへの搬送を禁止し、same-originのFetch MetadataとOriginを検査する。GET/HEADでOriginが省略されるブラウザーの同一origin要求も扱う。別share/別unlock credential・private session・purpose違い・manifestにないnode/blobを拒否する。共有範囲・rootからspace rootまでの生存状態・owner・version・epoch・session/ticketの失効と期限を、blobを解決するD1 batchでも確認する。

content hostの配信と同じBudgetDO・lease・ストリーム処理を使う。元の匿名credentialの`s:<shareId>:c:<unlockId>`へ会計し、session更新・別タブ・配信hostの切替で使用量をリセットしない。対象bytesの3倍、10分に1,024 request、同時8本を共通に適用する。HEAD/304/416も1 requestを計上し、本文bytesは0。単一Rangeは206、If-Range不一致と無視するmulti-rangeは全体bytesを先に予約する。GET/HEADのたびにticket/session/manifestを新規作成しない。

上書き後は元manifestのblobと一致しないため旧セッションで新しい本文や304を返さず、現行内容を対象に再発行する。ticket取消し・logout・共有変更・owner停止・祖先trash・範囲外への移動後も拒否する。R2不在・世代不一致は503。本文開始前の既知失敗は0byte、途中の取消し・結果不明は全予約bytesを保持し、配信期限は既存leaseへ従う。

原本の共通応答に`default-src 'none'; sandbox; frame-ancestors 'none'`のCSPと安全なASCII fallback filenameを付ける。HTML/SVGはattachment、元のUnicode名はfilename*を使用する。公開APIの成功/拒否すべてにprivate/no-store・nosniff・no-referrerを付け、HEADのエラーも本文なしにする。公開画面の「開く・保存」は従来のcontent host Cookie経路を使い、大きなfileをブラウザーで一括bufferする経路は追加しない。thumb・page・track・ZIPはそれぞれの派生処理とpurpose検証を接続する必要がある。

## 公開フォルダー作成と名前変更

`POST .../:id/nodes`は`{kind:"folder",parentId,name}`、`PATCH .../:id/nodes/:nodeId`は`{name}`だけを受ける。space/owner/share/credentialやDAV lock tokenを本文から指定できない。8KiB/5秒以内のJSON、exact Origin/same-origin、現行Cookieとpublic CSRF、`Idempotency-Key`を必須とする。さらにroot GETが返す非秘密の`sessionId`を`Share-Session`ヘッダーへ指定する。別タブの再認証でCookieが別credentialへ変わったら412として、旧keyを新credentialの新規操作にしない。

既存のcreateFolder/renameNode、LockDO、operation/permit、原子的D1 batchをそのまま使う。共有範囲・actions・version・credential・祖先・owner・epochを保存時にも検証する。閲覧link、範囲外、共有root自体の名前変更は404。DAV lockは423で、匿名者がlock creatorを偽装する経路はない。activityのactorはnullで、operationへ匿名credentialとshareを記録する。成功時は内部operandやowner情報を含まない既存のoperation receiptを返す。

既存`GET /api/v1/operations/:operationId`に`X-Share-Id`を付けると公開認証経路を選ぶ。`Share-Session`、当該Cookie、same-originを要求し、Accessや他の共有Cookieへfallbackしない。元と同じcredential/version/epochと、現在の元operandへの権限がある場合だけreceiptを返す。別credentialや権限を失ったoperandは404、失効Cookieは401。不明なDB結果は503。

root GETの`permissions.createFolder/rename`で編集操作を表示するが、APIの現在の認可が常に正となる。画面は送信中の重複操作を防ぎ、結果不明なら名前・key・元sessionをメモリーに固定する。「結果を確認」でOperation-IdがあればGET照会し、ID自体を受信できなかった場合だけ同じ要求を同じkeyで明示的に再送する。自動再送しない。401/403/404/412では新credentialや新keyへ切り替えず、共有内容の再確認を案内する。編集フォームを閉じると追跡は終了し、実行の取消しにはならない。reload/タブ終了後の追跡復元は未対応で、再度作成する前に一覧確認を案内する。

## 公開編集リンクからの削除

`DELETE .../:id/nodes/:nodeId`を既存のtrash処理へ接続した。現在の編集権限、同一origin/public CSRF、元の`Share-Session`、`Idempotency-Key`を必須にし、JSON本文には一覧で確認した`revision`だけを受ける。space/owner/credentialやDAV lock tokenを指定できない。親を含む現在の共有範囲、対象revision、元session/version/epoch、owner状態を取得時・LockDO・確定batchで再検査する。共有rootそのものはfileでもfolderでも削除できない。

公開画面の「ごみ箱へ移動」は対象名とフォルダー内の項目も移動すること、復元を共有した方に依頼することを説明して確認する。root permissionsのdeleteに従って表示し、選択時のrevisionを固定する。内容が変わった対象は412で拒否して一覧の再確認を案内する。同期処理の上限はfolder自身を含め1,000 live nodeで、超過は413。子孫や祖先のDAV lockにも従う。

既存の13-step transactionでtrash membership・node不可視化・親/tree更新・内部のlock終了・子孫に設定された共有とsessionの失効・ownerの短期ticket/content session失効・activity/outboxを同時に確定する。別のtrashに属する削除済み子を今回のmembershipへ含めない。namespaceの削除はR2実体の削除や容量の返金ではなく、所有者の既存restore/purge/GCへ引き継ぐ。公開利用者へごみ箱の一覧・復元・完全削除権限は与えない。

migration0065は既存trashのactorと被参照IDを保ったままactor_idをnullableにする。匿名操作ではtrash/activityのactorはnull、operationsの元link/credential/versionで帰属を記録し、所有者へ置き換えない。actor/space/root/reason/epochを後から変更できず、匿名trash作成時に元operationとcredential/shareの対応を要求する。復旧監査は失効済みの元sessionも履歴として照合し、不正な帰属を拒否する。既存のbackup/restore書込み凍結を優先する。migrationは停止・未処理受付なしで適用する。

成功はHTTP200のoperation receipt（result.statusは204）。削除後のnode内容は返さず、元と同じsession/key/revisionで終端を読み戻す。既知のOperation-IdはGETで確認する。公開receiptと後続eventは元の親に対する現在の編集権限も確認し、別sessionや編集権限を失った共有へ渡さない。編集画面の追跡はメモリー内に限られ、reload/タブ終了後は一覧を確認する。

## 公開アップロードと上書きAPI

編集linkの`POST .../:id/uploads`は`mode:"single"|"multipart"`、`parentId`、`name`、`declared_size`、任意の`targetId/targetRevision`を受ける。space/owner/share/credentialは本文から指定できない。直接共有したfileの上書きはparentIdを省略でき、認可したtargetから内部で親を解決する。閲覧linkと共有範囲外は拒否する。

全upload経路は現在の共有Cookieと元の`Share-Session`を要求する。JSON変更にはpublic CSRF、受付と確定には`Idempotency-Key`も必要。binary PUTは`Upload-Capability`、exact Origin、既知のContent-Lengthを要求し、partには`Upload-Attempt-Id`、上書きには現行blobの`If-Match`を要求する。`PUT .../uploads/:uploadId/content`または`parts/:number`、空JSONの`POST .../complete`、capability付き`GET .../:uploadId`と空JSONの`DELETE .../:uploadId`を既存の転送・確定・中止処理へ接続する。GETは厳格なafter/limitによるpart一覧を扱う。

migration0064でuploadsへ変更不可のlink_share_id/versionを追加した。既存のsource=privateはDAV以外のcapability転送形式として維持し、内部共有のselected_shareとは区別する。HMACと受付digestへ共有情報を含め、元の匿名credential・epochと照合する。従来のprivate capability入力は変えない。移行はmaintenance中かつopen permit・claimed operation・未閉鎖admissionがない場合だけ行う。

受付、R2実行許可、公開確定、status/operation照会はcreate/editに加えてupload actionを検査する。共有・credentialの失効、owner停止、祖先trash、quota超過、別unlock sessionへの差替えを拒否する。匿名activityのactorはnull、operationは元のlink principalを保存する。停止や失効で未確定のR2処理を終了済みとせず、既存のnative終了・実体確認に従って容量を精算する。確定済み/失敗済みoperationの内部修復では元の共有情報を照合し、失効後の新規転送権限は与えない。

編集linkは所有者の容量予約を使う。share単位の追加予約上限と情報非開示receiptは後続のupload-only専用契約であり、既存編集linkのreservation_limit=0を容量ゼロとして扱わない。未確定の受付応答は同じkey・元sessionで照会/再送し、credentialやkeyを差し替えない。multipart中止の容量解放はnative handleの終了が証明された後になる。

## 公開アップロード画面と再開

root GETの`permissions.upload/overwrite`に従ってファイル選択と上書きを表示する。upload actionだけが取り消された場合も両操作を隠す。上書きは対象名と置換の説明を表示し、確認時点のtarget ID/revision/blobを固定する。選択した元ファイルの名前が違っても保存先の名前は変更しない。直接共有fileの上書きでは親IDを送らない。

95,000,000 bytes以下は単一PUT、それより大きいファイルはmultipartを選ぶ。上限は500 GiB、同時partは最大4、待機中の記録は画面で最大32件。Web Locksで同じ転送への別タブからの同時操作を拒否する。送信中は他の編集を無効にし、確認済みbyte数の進捗と一時停止を表示する。一時停止はブラウザーの通信を止めるだけで、サーバー側の処理の取消しを意味しない。

専用IndexedDB `ncf-public-uploads`へ、元share/session、受付/確定key、upload ID/capability、各partのattempt ID、上書き先と元ファイル照合情報を保存する。秘密URL・password・ファイル本体は保存しない。新規受付と各binary送信の前に記録の永続化を必須とする。再読み込みで復元しても自動送信せず、「結果を確認」「再開する」「送信を中止」を選択する。ファイルを再選択した場合、名前・サイズ・更新日時と先頭/末尾各64 KiBのSHA-256を照合する。全ファイルの内容一致を証明するhashではない。

単一PUTの結果が不明な場合は二度目のPUTを送らず、statusまたは元のoperationを照会する。分割はrevisionとgeometryが揃った全pageから完了partを確認し、完了分を再送しない。in_flight/unknownがあれば新規part送信を停止する。D1 pendingで元attemptの未開始が証明された場合だけ、明示再開で次のattemptへ進む。受付応答喪失は同じ受付key、確定応答喪失は同じ確定keyまたは受信済みOperation-Idで追跡し、sessionやkeyを付け替えない。

完了・中止後は記録を削除し、一覧を再取得する。共有終了・期限切れ・別sessionへの切替でも元の記録を除く。logoutは記録削除とclosed sessionの保存を同じIDB transactionで行い、通知が遅れた別タブの後続保存も拒否する。closed sessionには秘密情報を持たず、最長unlock期限に対応する7日後に掃除できる。「記録を削除」はサーバー処理の取消しではないことを確認してから実行し、別タブが転送lockを保持している間は削除しない。401/403/404/412では共有内容の再確認を案内し、別sessionで元転送を引き継がない。

## 次の接続と完了条件

1. upload-onlyを接続する。公開create/rename/deleteのreload後の操作追跡も残る。
2. 共有範囲・認証・失効と配信会計を、期限経過・祖先trash・最大規模・実ブラウザーでも継続検証する。
3. public側のthumb/page/trackなど、未接続の派生配信経路を契約へつなぐ。原本GET/HEAD APIは接続済みで、画面の保存経路はcontent hostのticket/session経由である。
4. upload-only、ZIP、Gallery/Bookshelf/Audioを各phaseの契約へ接続する。upload-onlyの名前・衝突・既存file情報を開示しない。

APP_ORIGINとCONTENT_ORIGINを同じ値にする[単一host構成](SINGLE_HOST.md)にも対応する。Worker入口が/sessionと/cの名前空間を配信へ、それ以外の既知app pathを各認可handlerへ振り分ける。host-only CookieとCSP/attachment、private/public asset境界、元share/sessionの制約を維持する。別originのcontent hostにはapp routerを置かない。
5. stagingでAccess Bypass、Cookie、CORS、鍵切替、KDF予算、実配信を検証する。

検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。全体の残件は[CURRENT_STATE](CURRENT_STATE.md)。
