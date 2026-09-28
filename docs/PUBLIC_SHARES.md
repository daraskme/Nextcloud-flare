# 公開リンク共有

更新: 2026-09-28。schema0063・通常76table・147 route。所有者管理APIと匿名unlock/logout/CSRFは接続済み。公開画面・公開一覧/配信・実環境の共有はまだ利用できない。

## 所有者による管理

既存のAccess/CSRF付き`POST /api/v1/shares`は`kind:"link"`、`rootNodeId`、`role:"read"|"edit"`、任意の`expiresAt`と`password`を受ける。所有している現行root/subtreeだけを対象にする。内部共有の受信者や別の管理者に再共有の権限は与えない。パスワード計算の前後と確定batchで、元のAccess credential、所有者、祖先、epoch、maintenanceを検査する。

201には`id`、`version`、32-byte乱数の`secret`を一度だけ返す。URLの形は設計どおり`/s/<id>#<secret>`とするが、landingは後続工程。DBにはshare IDと用途に束縛したSHA-256 digestだけを保存し、平文secret・passwordを保存しない。GET/detail/listからsecret・digest・salt・KDF情報を返さない。

`GET /api/v1/shares?kind=link`と任意の`rootNodeId`は所有リンクだけを最大100件のkeysetで返す。cursorは用途、root、actor、credential、epochへ束縛する。内部共有と公開リンクのcursorを交換できない。期限切れリンクは所有者が確認・変更でき、無効化済み・祖先がtrashのリンクは隠す。`GET /api/v1/shares/:id`は現行所有者だけが公開リンクの設定を確認できる。既存の内部共有・受信共有の動作を維持する。

PATCHは`If-Match: "share-<version>"`を必須とし、root/kindを変更しない。password省略は保持、nullは削除、文字列は置換。`rotateSecret:true`は新しいsecretを生成し、その応答だけに返す。設定変更・秘密値更新・停止はversionを進め、share sessionと派生content session/ticketを同じbatchで失効させる。既存budgetの使用量や容量保持は変更しない。DELETEも同じversionと所有者認可を要求する。

作成・更新は共通mutation admissionへ接続する。D1の受付receiptで確定が確認できれば応答を回収できる。receipt照会まで失敗した場合は503を返し、自動でPOSTを繰り返さない。所有者は一覧で作成・version変更の有無を確認し、必要ならそのリンクの新しいversionを使ってsecretを更新する。失われたsecretは再表示できない。

## パスワード

UTF-8で1〜1,024bytes、入力を正規化・trimしない。不正なUnicode surrogateを拒否する。share IDと用途を含む入力を専用HMAC鍵で処理し、16-byte salt、PBKDF2-HMAC-SHA256 100,000回、32-byte出力を使用する。recordはdigest/salt/kdf/canonical params/kidを保存する。

新しい設定は`SHARE_PASSWORD_KEYS`と`SHARE_PASSWORD_ACTIVE_KID`。1〜3個の32-byte鍵を読み、active kidで新規保存する。app passwordやCookieの鍵を使い回さない。実行は既存のisolate内KDF制限とControlDOのglobal KDFへ渡す。公開側の照合helperは旧kidを含むringで読めるが、未知kidを受け付けず、KDFの混雑・不明結果をpassword不一致へ変換しない。remote secretは設定していない。

## 匿名認証

`POST /api/v1/public/shares/:id/unlock`は同じ経路で二段階の受付を行う。両段階ともexact Origin、Sec-Fetch-Site same-origin、8KiB/5秒以内のJSONを必須とする。最初の`{"step":"challenge"}`は共有の有無や設定を開示せず、5分の署名challengeを本文と`__Host-ncf_unlock_<id>` Cookieへ返す。既存の有効なchallengeを再利用する。CookieはSecure/HttpOnly/SameSite=Lax/Path=/。続く`{secret,password?}`はそのCookieと完全一致するX-CSRF-Tokenを必須とし、署名・share ID・epoch・origin・期限を検証する。このpre-unlock challengeは、R6の認証後CSRF発行APIとは別の用途である。

既存の有効な共有Cookieがあれば、challenge要求には認証済みのroot ID/version/期限だけを返し、KDFやsession作成を繰り返さない。新規認証は秘密値、必要ならpasswordを検証し、所有者・共有設定・root/祖先・epoch・停止状態をsessionとcredentialの登録batchで再検査する。Cookie署名鍵は専用`SHARE_COOKIE_KEYS`/`SHARE_COOKIE_ACTIVE_KID`。Access設定やprivate CSRF鍵は公開認証に不要で、用途違いのtokenを受け付けない。

認証済みCookieは`__Host-ncf_share_<id>`、Secure/HttpOnly/SameSite=Lax/Path=/、最長7日かつshare期限以内。share/version/session/epoch/origin/iat/exp/nonceを署名する。D1にはnonceの用途別digestだけを保存し、同じchallengeから同じsession IDを導く。並行送信、batch ACK喪失、receipt照会失敗後も同じchallengeを使って再試行でき、二つ目のcredentialを作らない。有効なsessionの期限を延長せず、失効済みの行を復活させない。challenge喪失・期限切れ後の同一性は保証しない。ブラウザーの初回同時タブとCookie共有はpublic UIのE2Eで別途検証する。

`POST /api/v1/public/shares/:id/csrf`は本文なし、exact Origin/same-originと現行共有Cookieを必須とし、既存のpublic用CSRF（1時間・再使用/再発行可）を返す。logoutはそのCSRFと空JSON objectを要求し、当該unlock credentialのshare session、派生content session、ticketを同じbatchで失効させる。他の匿名閲覧者やbudgetの使用量は変更しない。成功時に共有Cookieとchallenge Cookieを削除する。共有のversion更新/失効・owner停止・祖先trash・期限・epoch不一致後は既存Cookieを受け付けない。

## 試行回数

edge limiterに加え、ControlDOの`admitShareUnlock`がrolling 60秒で共有10回・client IP30回を一括で計上する。信頼済みCF-Connecting-IPだけを使い、IPv6表記を正規化する。productionでIPが得られない場合は503とし、developmentだけloopbackを使う。raw IPはDOへ永続保存せず、DO内の独立した乱数saltによるHMACをkeyに使う。

rate ledgerはDO SQLiteへ保存し、eviction・epoch変更で使用量を消さない。最大4,096key、keyごと最大30時刻と期限indexで容量を制限し、満杯は429。状態が初めて作られた場合や全喪失後は60秒待機する。時計の逆行、停止、D1 mirror不一致、RPCの結果不明は拒否する。失敗した認証の回数は返金せず、RPCを自動再送せず、KDFへ先に進まない。KDFそのものは既存のglobal/isolate制限へ接続する。rate ledgerはD1 backup対象ではなく、喪失時の待機で再開する。

## 次の接続と完了条件

1. landingを接続し、fragmentを直ちにhistoryから除去して秘密値をpath/query/logへ出さない。challenge/認証/再試行・Cookie・初回同時タブを実browserで検証する。
2. 別のpublic build/asset manifest/SRI/CSPを作り、private chunkや認証clientを混入させない。公開リンクの所有者UIも、実際に開けるlandingと合わせて接続する。
3. 公開一覧・content ticket/session・全byte/requestのBudgetDO会計、失効・祖先trash・期限・別tabを匿名E2Eで確認する。
4. edit/upload-only、ZIP、Gallery/Bookshelf/Audioを各phaseの契約へ接続する。upload-onlyの名前・衝突・既存file情報を開示しない。
5. stagingでAccess Bypass、Cookie、CORS、鍵切替、KDF予算、実配信を検証する。

検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。全体の残件は[CURRENT_STATE](CURRENT_STATE.md)。
