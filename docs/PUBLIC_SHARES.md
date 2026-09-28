# 公開リンク共有

更新: 2026-09-28。schema0063・通常76table・147 route。所有者管理APIは接続済み。匿名unlock・公開画面・実環境の共有はまだ利用できない。

## 所有者による管理

既存のAccess/CSRF付き`POST /api/v1/shares`は`kind:"link"`、`rootNodeId`、`role:"read"|"edit"`、任意の`expiresAt`と`password`を受ける。所有している現行root/subtreeだけを対象にする。内部共有の受信者や別の管理者に再共有の権限は与えない。パスワード計算の前後と確定batchで、元のAccess credential、所有者、祖先、epoch、maintenanceを検査する。

201には`id`、`version`、32-byte乱数の`secret`を一度だけ返す。URLの形は設計どおり`/s/<id>#<secret>`とするが、landingは後続工程。DBにはshare IDと用途に束縛したSHA-256 digestだけを保存し、平文secret・passwordを保存しない。GET/detail/listからsecret・digest・salt・KDF情報を返さない。

`GET /api/v1/shares?kind=link`と任意の`rootNodeId`は所有リンクだけを最大100件のkeysetで返す。cursorは用途、root、actor、credential、epochへ束縛する。内部共有と公開リンクのcursorを交換できない。期限切れリンクは所有者が確認・変更でき、無効化済み・祖先がtrashのリンクは隠す。`GET /api/v1/shares/:id`は現行所有者だけが公開リンクの設定を確認できる。既存の内部共有・受信共有の動作を維持する。

PATCHは`If-Match: "share-<version>"`を必須とし、root/kindを変更しない。password省略は保持、nullは削除、文字列は置換。`rotateSecret:true`は新しいsecretを生成し、その応答だけに返す。設定変更・秘密値更新・停止はversionを進め、share sessionと派生content session/ticketを同じbatchで失効させる。既存budgetの使用量や容量保持は変更しない。DELETEも同じversionと所有者認可を要求する。

作成・更新は共通mutation admissionへ接続する。D1の受付receiptで確定が確認できれば応答を回収できる。receipt照会まで失敗した場合は503を返し、自動でPOSTを繰り返さない。所有者は一覧で作成・version変更の有無を確認し、必要ならそのリンクの新しいversionを使ってsecretを更新する。失われたsecretは再表示できない。

## パスワード

UTF-8で1〜1,024bytes、入力を正規化・trimしない。不正なUnicode surrogateを拒否する。share IDと用途を含む入力を専用HMAC鍵で処理し、16-byte salt、PBKDF2-HMAC-SHA256 100,000回、32-byte出力を使用する。recordはdigest/salt/kdf/canonical params/kidを保存する。

新しい設定は`SHARE_PASSWORD_KEYS`と`SHARE_PASSWORD_ACTIVE_KID`。1〜3個の32-byte鍵を読み、active kidで新規保存する。app passwordやCookieの鍵を使い回さない。実行は既存のisolate内KDF制限とControlDOのglobal KDFへ渡す。公開側の照合helperは旧kidを含むringで読めるが、未知kidを受け付けず、KDFの混雑・不明結果をpassword不一致へ変換しない。remote secretは設定していない。

## 次の接続と完了条件

1. 匿名unlock、share-bound Cookie/CSRF、share/IP別rate limitを接続する。fragmentはlandingが直ちにhistoryから除去し、秘密値をpath/query/logへ出さない。
2. 別のpublic build/asset manifest/SRI/CSPを作り、private chunkや認証clientを混入させない。公開リンクの所有者UIも、実際に開けるlandingと合わせて接続する。
3. 公開一覧・content ticket/session・全byte/requestのBudgetDO会計、失効・祖先trash・期限・別tabを匿名E2Eで確認する。
4. edit/upload-only、ZIP、Gallery/Bookshelf/Audioを各phaseの契約へ接続する。upload-onlyの名前・衝突・既存file情報を開示しない。
5. stagingでAccess Bypass、Cookie、CORS、鍵切替、KDF予算、実配信を検証する。

検証記録は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。全体の残件は[CURRENT_STATE](CURRENT_STATE.md)。
