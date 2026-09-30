# 公開リンク

更新: 2026-09-29。

## 実装範囲

Files UI の所有者は、自分が所有する live node を root にした期限付きの読み取り専用link、またはfolder rootのupload-only linkを作成・一覧・参照・無効化できる。作成時だけ `/s/<shareId>#<secret>` を返す。D1 には capability の SHA-256 digest だけを保存し、再表示しない。任意の共有passwordを両share種別へ設定でき、一覧と作成結果には保護の有無だけを返す。現在の上限は所有者あたり active 100件、期限は1〜365日（既定30日）。

public landing は fragment を JSON body で unlock API へ送る。保護されたshareで capability が正しい場合だけpassword入力を表示し、その時点でcapabilityをmemoryに保持したままfragmentをhistoryから除去する。passwordはURL・DOMの結果表示・保存領域へ入れない。unlock成功後にshare ごとの `Secure; HttpOnly; SameSite=Lax; Path=/` Cookie を発行する。raw Cookie は保存せず、`share_sessions.secret_digest` に digest を保存する。有効期限は share 期限と7日の短い方である。

共有passwordは1〜1,024 UTF-8 bytesとし、専用pepper key ringでHMACした後、canonical ControlDOのPBKDF2-SHA256（100,000回、16-byte salt、32-byte digest）へ送る。D1に保存するのはdigest、salt、固定KDF params、pepper `kid`だけである。新規作成にはactive `kid`を使い、旧`kid`でのunlock成功時はsession発行と同じadmitted transactionでactive keyへre-hashする。旧pepperは参照中のactive shareが0になるまで保持し、不足時はpassword不一致ではなく503を返す。password KDFはshareごと10回/分、client IPごと30回/分の両方へ先に通し、全体KDF admissionも共有する。rate limitは429、KDF/受付停止はpassword不一致と区別して503を返す。

public session は各 request で次を再検査する。

- owner と share root の live ancestry。
- share disabled/expiry/version。
- session revoked/expiry/epoch。
- ControlDO mirror の current epoch と maintenance。
- share action と、選択 root 配下の node coverage。

接続済み public API は次の14経路である。

- `POST /api/v1/public/shares/:shareId/unlock`
- `GET /api/v1/public/shares/:shareId`
- `GET /api/v1/public/shares/:shareId/children/:nodeId`
- `POST /api/v1/public/shares/:shareId/csrf`
- `POST /api/v1/public/shares/:shareId/logout`
- `POST /api/v1/public/shares/:shareId/tickets`
- `DELETE /api/v1/public/shares/:shareId/tickets/:ticketId`
- `POST /api/v1/public/shares/:shareId/content-session`
- `POST /api/v1/public/shares/:shareId/uploads`
- `GET /api/v1/public/shares/:shareId/uploads/:uploadId`
- `PUT /api/v1/public/shares/:shareId/uploads/:uploadId/content`
- `PUT /api/v1/public/shares/:shareId/uploads/:uploadId/parts/:partNumber`
- `POST /api/v1/public/shares/:shareId/uploads/:uploadId/complete`
- `DELETE /api/v1/public/shares/:shareId/uploads/:uploadId`

public mutation は app origin、`Origin`、Fetch Metadata、JSON、public 専用 CSRF、share/session の現行性を検査する。unlock確定時は capability、epoch、share version、password metadata、live ancestryを同じD1 batchで再検査し、KDF中の変更から古いsessionを発行しない。logout は share session と派生 content session を失効し、active budget を revoke する。

file 選択時は share root 配下の file だけを target manifest に固定し、share session の期限内で短命 content ticket を発行する。browser は分離された `CONTENT_ORIGIN/session` で ticket を HttpOnly content Cookie に交換してから `/c/<nodeId>/<blobId>` を開く。R2 key は client へ返さない。content origin は D1 authority、manifest、share version/epoch/action、現在の blob、BudgetDO lease を再検査して immutable R2 object を配信する。同じ unlock session の再発行は同じ budget を再利用し、ticket cancel は派生 content session も失効する。

upload-only shareは`create`と`upload` actionだけを持ち、metadata、children、ticket、content session、downloadを拒否する。recipientは既存nodeの指定や上書きをできず、share root直下への新規作成だけを要求できる。各receiptはowner quotaとshare `reservation_limit`を同じD1 transactionで予約し、share/session/version/epoch/expiryを作成・転送・状態照会・完了・中止の各段階で再検査する。公開受信は1件10 GiB、同時active 8件、shareあたり累計1,000件を上限とする。

singleとmultipartはprivate uploadと同じimmutable R2、UploadDO、LockDO、operation terminalを使う。名前衝突はnamespace lock内で自動解決し、public responseはreceipt ID、状態、進行情報だけを返して、入力名・内部upload名・最終保存名を返さない。初期化・part・完了の結果が不明な場合はreceipt、capability、作成/part/完了のIdempotency-Keyを保持して同じ送信を再照会し、推測でabortや予約解放をしない。batch途中で完了したfileは再送queueから除外する。multipart初期化・中止・完了の進行中状態は202と`Retry-After`で返す。

## assets と cache

public shell は `/s` と `/s/:shareId` だけを no-store で返す。JS/CSS は private SPA と別 Vite entry から content hash 付き `/public-assets/*` へ出力し、生成 manifest の完全一致だけを immutable cache で配信する。private `/private-assets/*` と相互参照しない。

## 未接続

app origin の直接 content proxy、内部共有、shared DAV、ZIP、Gallery、Bookshelf、Audio と public media/library route は未接続であり、route registry は 404 fail closed を維持する。remote secret、migration、staging/production deployは実施していない。

## ローカル検証

- capability の正誤、Cookie 属性、metadata/children、root 外拒否。
- passwordなし互換、digest-only保存、正解/欠落/不正/長過ぎpassword、per-share/IP制限、KDF停止。
- disabled/expired/epoch mismatch、KDF中のversion/password変更、失敗時session未発行。
- share 間 Cookie 分離、version/epoch mismatch、CSRF logout と失効。
- public ticket の CSRF、root coverage、target manifest、content Cookie 交換、budget 再利用、R2配信、ticket cancel 後の拒否。
- upload-only作成、owner/share二重予約、single/multipart転送・完了・中止、bounded status、容量上限、read/list拒否。
- namespace lock内の衝突回避、最終名非開示、同じIdempotency-Keyによる完了再試行。
- 初期化/partの202再照合と、batch途中の失敗後に完了済みfileを重複送信しないqueue。
- public CSRF、session失効、share version/disabled/expiry fence。
- upload-only UIはfolderだけを選択可能にし、recipient UIはchildren/ticketを呼ばず、最終保存名を表示しない。
- owner 以外の作成/参照/無効化拒否、無効化の一度だけの version 更新と派生 session 失効。
- hashed public assets、private assets 非参照、shell no-store、asset immutable cache。
- route registry の exact allowlist と未実装 route の fail closed。
