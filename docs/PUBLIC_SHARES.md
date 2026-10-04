# 公開リンク

更新: 2026-10-04。

## 実装範囲

Files UI の所有者は、自分が所有する live node を root にした期限付きの読み取り専用link、またはfolder rootのupload-only linkを作成・一覧・参照・無効化できる。作成時だけ `/s/<shareId>#<secret>` を返す。D1 には capability の SHA-256 digest だけを保存し、再表示しない。任意の共有passwordを両share種別へ設定でき、一覧と作成結果には保護の有無だけを返す。現在の上限は所有者あたり active 100件、期限は1〜365日（既定30日）。

public landing は fragment を JSON body で unlock API へ送る。保護されたshareで capability が正しい場合だけpassword入力を表示し、その時点でcapabilityをmemoryに保持したままfragmentをhistoryから除去する。passwordはURL・DOMの結果表示・保存領域へ入れない。unlock成功後にshare ごとの `Secure; HttpOnly; SameSite=Lax; Path=/` Cookie を発行する。raw Cookie は保存せず、`share_sessions.secret_digest` に digest を保存する。有効期限は share 期限と7日の短い方である。

既存の有効なshare Cookieを伴うunlockは、capabilityと必要なpasswordを確認した後、同じsessionを再利用する。新規sessionはshare/version/epochあたり64件、sourceあたり8件が上限で、前読と最終D1 transactionの両方で確認する。期限切れ・失効済みの行は両上限に数えない。参照中のcredential、budget、ticketとの外部キーを保つため、unlock時に履歴行を物理削除しない。他の有効なsessionを追い出さず、上限時は新規unlockを拒否する。

sourceはCloudflareが設定する`CF-Connecting-IP`をIPv4は単一address、IPv6は/64 prefixに正規化し、public CSRF署名鍵でshare別のHMAC digestにして保存する。生IPやprefixはD1に保存しない。共有NATの利用者は同じ8枠を共有する。異なる8 sourceから各8件発行できるため、64件のshare全体枠を分散して枯渇させる攻撃は残る。鍵更新時は旧digestと新digestが異なるため、一時的にsource枠を跨げる。これは単一sourceの費用と枠消費を抑える境界であり、分散DoSの完全防止ではない。

共有passwordは1〜1,024 UTF-8 bytesとし、専用pepper key ringでHMACした後、canonical ControlDOのPBKDF2-SHA256（100,000回、16-byte salt、32-byte digest）へ送る。D1に保存するのはdigest、salt、固定KDF params、pepper `kid`だけである。新規作成にはactive `kid`を使い、旧`kid`でのunlock成功時はsession発行と同じadmitted transactionでactive keyへre-hashする。旧pepperは参照中のactive shareが0になるまで保持し、不足時はpassword不一致ではなく503を返す。password KDFはshareごと10回/分、client IPごと30回/分の両方へ先に通し、全体KDF admissionも共有する。rate limitは429、KDF/受付停止はpassword不一致と区別して503を返す。

public session は各 request で次を再検査する。

- owner と share root の live ancestry。
- share disabled/expiry/version。
- session revoked/expiry/epoch。
- ControlDO mirror の current epoch と maintenance。
- share action と、選択 root 配下の node coverage。

公開shellとmanifestに列挙した静的assetは、共有データを含まない公開リソースであるため、maintenance中も配信する。Workerの`GET /public-assets/:asset`と`GET /s/:shareId`は`admittedEpoch`を通さない。共有一覧・ticket・contentなどのAPIはadmissionを通し、maintenance中は利用できない。maintenance解除後も、各share requestでcurrent epoch、maintenance、shareの失効/期限、owner停止、session状態を再検査するため、公開shellやassetを保持していても失効したshareを再利用できない。

接続済み public API は次の23経路である。

- `POST /api/v1/public/shares/:shareId/unlock`
- `GET /api/v1/public/shares/:shareId`
- `GET /api/v1/public/shares/:shareId/children/:nodeId`
- `GET /api/v1/public/shares/:shareId/gallery`
- `GET /api/v1/public/shares/:shareId/tracks`
- `POST /api/v1/public/shares/:shareId/csrf`
- `POST /api/v1/public/shares/:shareId/logout`
- `POST /api/v1/public/shares/:shareId/tickets`
- `DELETE /api/v1/public/shares/:shareId/tickets/:ticketId`
- `POST /api/v1/public/shares/:shareId/content-session`
- `GET /api/v1/public/shares/:shareId/library/:nodeId`
- `GET|HEAD /api/v1/public/shares/:shareId/library/:nodeId/pages/:page`
- `GET|HEAD /api/v1/public/shares/:shareId/library/:nodeId/entries/:entryToken`
- `POST /api/v1/public/shares/:shareId/nodes/:nodeId/zip`
- `GET /api/v1/public/shares/:shareId/zips/:zipId`
- `POST /api/v1/public/shares/:shareId/uploads`
- `GET /api/v1/public/shares/:shareId/uploads/:uploadId`
- `PUT /api/v1/public/shares/:shareId/uploads/:uploadId/content`
- `PUT /api/v1/public/shares/:shareId/uploads/:uploadId/parts/:partNumber`
- `POST /api/v1/public/shares/:shareId/uploads/:uploadId/complete`
- `DELETE /api/v1/public/shares/:shareId/uploads/:uploadId`

public mutation は app origin、`Origin`、Fetch Metadata、JSON、public 専用 CSRF、share/session の現行性を検査する。unlock確定時は capability、epoch、share version、password metadata、live ancestryを同じD1 batchで再検査し、KDF中の変更から古いsessionを発行しない。logout は share session と派生 content session を失効し、active budget を revoke する。

file 選択時は share root 配下の file だけを target manifest に固定し、share session の期限内で短命 content ticket を発行する。gallery と audio metadata は現在の image/audio projection だけを bounded query で列挙し、cursor を share、unlock credential、epoch、tree generation へ束縛する。thumbnail ticket は現在の immutable derivative、track ticket は現在の audio または AV1 video projection だけを対象にする。browser は分離された `CONTENT_ORIGIN/session` で ticket を HttpOnly content Cookie に交換してから purpose-bound content path を開く。R2 key は client へ返さない。content origin は D1 authority、manifest、share version/epoch/action、現在の blob/projection、BudgetDO lease を再検査し、Range/HEADを含む immutable R2 object 配信を行う。同じ unlock session の再発行は同じ budget を再利用し、ticket cancel は派生 content session も失効する。

app/public/admin のcontent ticketとprivate/public ZIP ticket発行は、targetごとにD1/R2検査へ入る前に`EDGE_LIMITER`で対象件数に応じた枠を消費する。1〜1,000 targetを8件ごとに1 creditへ切り上げ、1000件は125 creditとなる。private user、admin、public shareごとに安定したkeyを使い、別cookieによるshare枠の迂回を抑える。limiter拒否は429、limiter障害は503で、target検査とR2 HEADを始めない。現設定は300 credit/60秒だがCloudflareのedge-localなbest-effort制限であり、厳密な全世界共通枠や課金上限ではない。ZIPは発行要求時に1 creditを課し、展開後のentry/byte数は別途ZIP plannerが制限する。

読み取り専用shareのEPUB metadataは、現行の`epub-index-v1` projectionとshare root coverageを再検査して返す。page/entry app routeは本文をproxyせず、同じprojectionを再検査して`CONTENT_ORIGIN`のbounded page/entry targetへ307 redirectする。`purpose=page` ticketは単一の現行EPUB targetだけに発行し、content originはsource/index hash、current blob、ZIP local header/CRC、entry上限、share version/epoch/actionとBudgetDOを再検査する。HEADは本文bytesを課金せずrequestを会計する。encrypted、scripted、fixed-layout、malformed、oversized、unsupportedまたはstaleなpublicationはmetadata、ticket、redirect、本文の全段階でfail closedにする。

読み取り専用folderのZIP作成はpublic-form CSRFと`Idempotency-Key`を必須とし、share root配下のbounded treeだけを既存STORE plannerへ渡す。同じcredential/key/requestは同じimmutable manifest、ticket、budgetを再発行し、異なるrequestは409で拒否する。app originのZIP GETは現行share session、ticket、manifest、budgetを検査して`CONTENT_ORIGIN/z/:targetSetId`へredirectするだけで、ZIP bodyをproxyしない。content originはHEAD、単一Range、416、BudgetDOのrange-aware精算とsource cancelを行い、version/epoch/action/blob/path/pinを再検査する。

upload-only shareは`create`と`upload` actionだけを持ち、metadata、children、ticket、content session、downloadを拒否する。recipientは既存nodeの指定や上書きをできず、share root直下への新規作成だけを要求できる。各receiptはowner quotaとshare `reservation_limit`を同じD1 transactionで予約し、share/session/version/epoch/expiryを作成・転送・状態照会・完了・中止の各段階で再検査する。公開受信は1件10 GiB、同時active 8件、shareあたり累計1,000件を上限とする。

singleとmultipartはprivate uploadと同じimmutable R2、UploadDO、LockDO、operation terminalを使う。名前衝突はnamespace lock内で自動解決し、public responseはreceipt ID、状態、進行情報だけを返して、入力名・内部upload名・最終保存名を返さない。初期化・part・完了の結果が不明な場合はreceipt、capability、作成/part/完了のIdempotency-Keyを保持して同じ送信を再照会し、推測でabortや予約解放をしない。batch途中で完了したfileは再送queueから除外する。multipart初期化・中止・完了の進行中状態は202と`Retry-After`で返す。

## assets と cache

public shell は `/s` と `/s/:shareId` だけを no-store で返す。JS/CSS は private SPA と別 Vite entry から content hash 付き `/public-assets/*` へ出力し、生成 manifest の完全一致だけを immutable cache で配信する。private `/private-assets/*` と相互参照しない。

## 公開surface

分離されたpublic shellは、read-only linkにファイル、Gallery、Audioの切り替えを表示し、ファイル一覧の現行EPUBと動画にreader/player actionを表示する。Galleryは`purpose=thumb`と`purpose=content`、Audioと動画は`purpose=track`、EPUBは`purpose=page`を使い、content Cookie交換後の画像・音声・動画・本文bytesを`CONTENT_ORIGIN`から直接取得する。動画と音声は再生前にHEADで現行content typeを確認し、EPUB本文はDOM textへ縮退して`sandbox=""`と内部CSPを持つiframeへ表示する。画面移動、再試行、reader/lightbox/player close、native playback failure、logoutでは古いticketをcancelし、派生content sessionも失効させる。

bounded ZIPは既存のpublic ZIP plannerとapp-origin redirectだけを使い、shellはbodyをproxyしない。同じ画面からの再実行または画面移動で古いZIP ticketをcancelする。upload-only linkはGallery、Audio、reader、video、ZIP、childrenを表示・要求しない。relock、失効、revocation、stale projection、malformed/unsupported EPUB、unsupported codec/container、native playback failureは明示的なfail-closedまたはdownload fallbackを表示する。

direct-user内部共有とread-only shared DAVはprivate認証surfaceへ接続済みで、この公開link session/actionを共有認可へ流用しない。現在のremote適用状況は[ENVIRONMENT_STATUS](ENVIRONMENT_STATUS.md)を参照する。

group internal shareもprivate認証surfaceだけへ接続する。group recipientのbudget identityはshare action versionとmembership versionの両方へ束縛し、action変更またはmember削除/再追加後にrevoke済みbudgetを再利用しない。このfenceをpublic shareのunlock/session budgetへ流用しない。

## ローカル検証

- capability の正誤、Cookie 属性、metadata/children、root 外拒否。
- passwordなし互換、digest-only保存、正解/欠落/不正/長過ぎpassword、per-share/IP制限、KDF停止。
- disabled/expired/epoch mismatch、KDF中のversion/password変更、失敗時session未発行。
- share 間 Cookie 分離、version/epoch mismatch、CSRF logout と失効。
- valid Cookie再利用、単一source8件とshare全体64件、失効・期限切れ行の除外、IPv6 /64 HMAC、別sourceの有効session保持。
- content ticket拒否時にtarget/R2へ進まないこと、8 targetごとのcreditと1000件の125 credit。
- public ticket の CSRF、root coverage、target manifest、content Cookie 交換、budget 再利用、R2配信、ticket cancel 後の拒否。
- public EPUB metadata、upload-only/root外拒否、page/entry redirect、projection hash、GET/HEAD/Range、exact budget、share action失効。
- upload-only作成、owner/share二重予約、single/multipart転送・完了・中止、bounded status、容量上限、read/list拒否。
- namespace lock内の衝突回避、最終名非開示、同じIdempotency-Keyによる完了再試行。
- 初期化/partの202再照合と、batch途中の失敗後に完了済みfileを重複送信しないqueue。
- public CSRF、session失効、share version/disabled/expiry fence。
- upload-only UIはfolderだけを選択可能にし、recipient UIはchildren/ticketを呼ばず、最終保存名を表示しない。
- public media UIはGallery/Audio/EPUB/video/ZIPのticket交換、HEAD、sandbox、exact ZIP bytes、navigation/retry/close時cancel、upload-only非表示、relock/unsupported/native error fallbackをbrowserで検証する。
- owner 以外の作成/参照/無効化拒否、無効化の一度だけの version 更新と派生 session 失効。
- hashed public assets、private assets 非参照、shell no-store、asset immutable cache。
- route registry の exact allowlist と未実装 route の fail closed。
