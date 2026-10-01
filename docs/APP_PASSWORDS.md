# アプリパスワードとWebDAV資格情報

更新: 2026-10-01。

private appの`/settings/webdav`は、現在のAccessユーザーがWebDAV用アプリパスワードを一覧・発行・失効する設定画面である。WebDAVクライアント自体の設定や接続完了を保証する画面ではない。

## WebDAV資格情報

WebDAV endpointはprivate appと同じoriginの`/dav`である。HTTPS Basic認証へ次を設定する。

- username: 発行結果の公開ID（`ap_`で始まる値）
- password: 発行時に一度だけ返されるsecret

Access JWTやAccess session cookieはWebDAV資格情報として使わない。secretは一覧APIへ返さず、再表示・再取得できない。設定画面も発行応答をquery cache、URL、Web Storageへ保存せず、閉じるか画面を離れた後は保持しない。コピーまたは明示的なdownloadで安全な保管先へ移し、失った場合は失効して再発行する。

## 発行境界

`POST /api/v1/app-passwords`は現行Access sessionとCSRFを検査し、KDFとaccount mutation admissionを通してからD1へ資格情報を保存する。応答は`Cache-Control: private, no-store`で、生成したsecretを含む唯一の応答である。

入力境界は次のとおり。

- 名前はNFC正規化後にtrimし、1〜100文字かつUTF-8で256 byte以下。制御文字を許可しない。
- scopeは`node:read`、`node:create`、`node:write`、`node:delete`から重複なしで1〜4個を選ぶ。
- 有効期間は1〜365日の整数。省略時は90日。
- root制限を使う場合は`spaceId`と`rootNodeId`を組で渡す。現在のAccessユーザーがread可能で、かつ自分がownerであるnodeだけをrootにできる。
- 有効な資格情報はユーザーごとに最大20個。

rootを設定した資格情報は、そのrootの祖先・別owner・別spaceへ権限を拡張しない。DAV操作はscopeだけでなく、現在のowner/root ancestry、共有action、epoch、maintenance、lock、操作別認可を各既存境界で再検査する。内部共有DAVの能力との積は[DAV_UPLOAD](DAV_UPLOAD.md)の「編集可能な内部共有DAV」に従う。

## 一覧と失効

`GET /api/v1/app-passwords`は現在有効で未失効の最大20件を返す。名前、公開ID、失効用credential ID、root、作成・期限、scopeだけを返し、secretやdigestは返さない。Access sessionをD1 primaryで前後検査し、応答は`private, no-store`である。

`DELETE /api/v1/app-passwords/:credentialId`は現行Access session、CSRF、ownerを再検査し、account mutation admission内で失効する。同じbatchで、そのcredentialから発行した`content_sessions`も失効する。既に失効済みの同じ資格情報への再送は204を維持する。

発行・失効と認証時pepper更新の受付、KDF unavailable時の挙動は[KDF_ADMISSION](KDF_ADMISSION.md)と[MUTATION_ADMISSION](MUTATION_ADMISSION.md)に従う。資格情報管理は既存schemaを使用し、この設定画面の追加にmigrationはない。
