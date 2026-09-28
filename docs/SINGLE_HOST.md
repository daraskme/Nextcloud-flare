# 単一ドメイン構成

設計§8.2/§10.4の、APP_ORIGINとCONTENT_ORIGINに同じHTTPS originを設定する構成をWorker入口へ接続した。既存の2 origin構成も維持する。schema0065・通常76table・147 route、migration/依存追加なし。

## ルーティング

- originが別なら、CONTENT_ORIGINへの全要求は配信handlerだけへ渡す。Files、private/public assets、共有API、DAV、未知pathをappへ転送しない。
- originが同じなら、`/session`と`/c`・`/c/`以下を配信専用にする。壊れたpathや未対応methodもこの名前空間からappへ戻さない。
- その他の既知pathは従来のpublic assets、public share API、private API、DAV、private assetsの順に処理する。未知host/pathにSPA fallbackを返さない。Worker assetsはrun_worker_firstとnot_found_handling:noneを維持する。
- 公開landingと検証済みpublic bundleはAccessや配信鍵・admissionなしでも汎用画面だけを返す。私用API/画面/assetsはAccess認証、共有APIは共有認証を検査し、認証Cookieを相互に代用しない。配信・認可APIはControlDOとD1のepoch/maintenance gateを維持する。

## Cookieと原本の制限

`POST /session`はAPP_ORIGINと一致するOriginを必須とし、OPTIONSもPOST/Content-Typeだけを許可する。署名ticketから現行D1 sessionを作成し、Secure/HttpOnly/Path=/の`__Host-` Cookieを返す。Domain属性は付けない。単一hostでもCSRF・ticket/session/manifest・対象範囲・BudgetDOの検査を省略しない。私用cookie/share cookie/content cookieを持つだけで別の認証方式を代替できない。

原本応答はprivate/no-store・nosniff・no-referrerと`default-src 'none'; sandbox; frame-ancestors 'none'`を使う。HTML/SVG等はattachmentで返し、Unicode filename*と安全なASCII fallback名を使う。公開画面は同じticket搬送と保存UIを使い、大容量をブラウザーへ一括bufferする経路は追加しない。

## ローカル検証

`pnpm test:browser`は従来のapp/content別host（8879）。`pnpm test:browser:single-host`は単一host（8880）の専用Wrangler設定・`.wrangler/browser-single-host-tests`を生成する。両方ともローカルbindingだけを使う。CIは別jobで両構成を実行し、既存試験とjob時間上限を維持する。同じcheckoutのbuildと実行中のbrowser/workerd試験は同時に行わない。

native試験は2構成の認可境界・未知path/method・公開assets・CSRF/Origin/CORS・Cookieの属性・Range/HEAD・取消し・maintenanceを確認する。専用browserは実Files upload/download、390pxの匿名共有、配信Cookie・失効、HEAD/Range/304、HTML/SVGの添付保存を確認する。結果は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。

実CloudflareのAccess policy、DNS/TLS、route設定・stagingは未検証。実環境では公開pathと配信pathがAccessで遮られずWorkerの認可まで到達する構成を別途確認する。thumb/page/track/ZIP・媒体viewerは本対応の完成範囲に含めない。
