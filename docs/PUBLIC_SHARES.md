# 公開リンク共有

更新: 2026-09-28。schema0063・通常76table・147 route。所有者管理API、匿名unlock/logout/CSRF、独立公開画面・一覧・content ticketによる配信を接続済み。所有者UIと実環境の共有は未完了。

## 所有者による管理

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

## 次の接続と完了条件

1. 所有者UIでリンク作成・期限/password・秘密値更新・停止を操作できるようにする。結果不明のPOSTを自動再送せず、一覧確認と秘密値再発行を案内する。
2. 共有範囲・認証・失効と配信会計を、期限経過・祖先trash・最大規模・実ブラウザーでも継続検証する。
3. public側の直接content/thumbなど、未接続の専用配信経路を契約へつなぐ。現在の画面の保存経路はcontent ticket/session経由である。
4. edit/upload-only、ZIP、Gallery/Bookshelf/Audioを各phaseの契約へ接続する。upload-onlyの名前・衝突・既存file情報を開示しない。
5. stagingでAccess Bypass、Cookie、CORS、鍵切替、KDF予算、実配信を検証する。

検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。全体の残件は[CURRENT_STATE](CURRENT_STATE.md)。
