# Astra ラウンド3 指摘対応表

対象: `docs/DESIGN.md` v0.4

- ラウンド3の A1〜A5、Z1〜Z4、T1〜T6、C1〜C2、I1〜I2、W1〜W3、S1〜S4、§8 必須修正 P0/P1、追加受入試験を全件追跡する。
- 「採用」は v0.4 の実装契約へ反映済み。「後段」は v1 に安全な制限を置き、`DESIGN.md` §18 に明記したものを示す。
- ラウンド3時点の不採用はない。W1 は当時の確定方針に従ったが、**R4 で再変更（通常 mutation / refresh / UNLOCK すべて creator 一致を採用）**した。

## 1. Cloudflare Access 統合

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| A1 | §2.2, §4.1, §14.3, §15.2 | 採用 | JWT 入力を単一 `Cf-Access-Jwt-Assertion` header に固定し、RS256、固定 issuer、route 別 AUD、claim 型、60秒 skew、24h 最大寿命を契約化した。 |
| A2 | §1, §4.1, §13.4, §15.2 | 採用 | JWKS を KV 1h / stale 24h、未知 kid 一回、single-flight、10回/分、bounded negative cache、取得失敗時 fail-closed にした。 |
| A3 | §2.2, §4.1–4.3, §5.1 | 採用 | user と `common_name` service を別 principal にし、Service Auth 専用 route と scope×mapped user×space の積集合を定義した。 |
| A4 | §4.4, §4.5, §5.4, §8.1, §9, §11.3 | 採用 | Access 残存 JWT を伝播上限とし、user / credential / share / job を primary で毎回確認し、logout と進行中 stream の境界を固定した。 |
| A5 | §2.2, §14.1, §14.3, §15.2–15.3 | 採用 | method+template allowlist、`/dav` と `/dav/*`、全 host / alias / environment の HTTPS・入口制限・実 HTTP gate を定義した。 |

## 2. 認可、endpoint、復旧 epoch

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| Z1 | §2.2, §4.2–4.3, §5.1, §7, §15.1 | 採用 | 宣言的 manifest から Hono を生成し、全 route の auth / operation / operands / adminOnly と `Authorized<...>` 型を CI で被覆する。 |
| Z2 | §3.2, §4.2, §8.2, §11.1, §12, §15.2 | 採用 | 全 read で node から space root まで深さ64の `EffectiveLive` 再帰 CTE を一クエリ実行し、祖先 trash 直後から同期的に拒否する。 |
| Z3 | §3.1, §4.2–4.3, §5.2, §15.2 | 採用 | ID 所有と current 権限を分け、terminal result は同 principal・同 credential かつ再認可成功時だけ再生する。owner 例外で scope を広げない。 |
| Z4 | §3.5, §5.2, §5.4, §7.3, §11.3, §15.2 | 採用 | D1 `control.epoch` guard を全 commit barrier へ入れ、UploadDO / LockDO は epoch 不一致で `stale` 409 とした。 |

## 3. セッション、トークン、KDF

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| T1 | §3.1, §4.5, §8.1, §15.3 | 採用 | unlock Cookie を `__Host-ncf_share_<shareIdShort>`、Secure / HttpOnly / Lax / Path=/、share/version/session/kid 束縛、最長7日に固定した。 |
| T2 | §4.5, §8.2, §13.1 | 採用 | ticket を typ / aud / jti / kid / exp / epoch /対象へ束縛し、署名検証前の DO 生成禁止、share expiry、個別 cancel と同一 budget を定義した。 |
| T3 | §4.5, §7.1, §13.1, §14.2 | 採用 | app password を256-bit、既定90日/最大365日、20件/user、scope変更時再発行、HMAC key ring と current grant の積集合にした。 |
| T4 | §4.5, §5.1, §8.1, §13.2, §15.2 | 採用 | 公開 JSON mutation に exact Origin、`Origin:null` 拒否、same-origin Fetch Metadata、JSON、用途束縛 one-time CSRF を必須化した。 |
| T5 | §3.1, §4.2, §4.5, §5.4, §6.3 | 採用 | upload ID と bearer capability を分離し、creator / credential / share version / expiryへ束縛、全操作で current 認可、logout時 IndexedDB 削除を定義した。 |
| T6 | §4.5, §13.1, §14.2, §18.5 | 採用（scrypt 選択は staging） | PBKDF2-SHA256 600,000を既定とし、salt/DK/input、share10・IP30・global600回/分、同時20を固定。scryptは安全 gate 後だけ versioned config で選ぶ。 |

## 4. コンテンツ、encoding、入力 parser

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| C1 | §9, §9A, §10.4, §13.2, §15.2, §18.8 | 採用 | MIME×CONTENT_HOST/単一host matrix、server Content-Type、Disposition、CSP、sandboxを確定し、単一hostのactive形式をattachmentにした。 |
| C2 | §3.3, §5.3, §9, §10.5, §13.3, §15.2 | 採用 | RFC 6266、React text、XML writer、CSV formula対策、JSON serializer、masked JSON log、危険ZIP名の全体拒否を出力先別に定義した。 |
| I1 | §2.2, §3.3, §6.1, §13.1, §15.1 | 採用 | 不正UTF-8/percent、NFC後のportable名、JSON非decode、JSON 1MiB/深さ32、名前byte/文字、URL上限を固定した。 |
| I2 | §6.1, §7.2, §13.1, §15.1 | 採用 | XML・header・If・Destination・Depth・Timeout・Range・Content-Length・header数をbounded parser契約へ集約した。 |

## 5. WebDAV

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| W1 | §7.3, §15.2 | 採用（確定方針） | 通常 locked mutation は current write権限 + `If` tokenで許可しcreator照合なし、refreshはtokenのみ、UNLOCKだけcreatorまたはspace ownerに限定した。**R4 で再変更（creator 一致を採用）**。 |
| W2 | §7.3, §15.1–15.2 | 採用 | MOVE commit時にsource lockを終了しdestinationへ引き継がず、node ID alias解決とlock lifecycleを分離した。**R4 で再変更（creator 一致を採用）**。 |
| W3 | §0.3, §5.3, §7.3, §15.2 | 採用 | collection ETagをstrong `"<node_id>-<revision>"` にし、必須If-Matchをfile content PUTだけへ限定、他revision競合を409にした。**R4 で再変更（creator 一致を採用）**。 |

## 6. 秘密情報、bootstrap、ログ、development bypass

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| S1 | §3.1, §4.4, §11.3, §15.2 | 採用 | Google IdP+MFAの初回identityだけをiss+subへ固定し、`bootstrap_done_at IS NULL` の一回性batch後はOWNER_EMAILSを無視する。 |
| S2 | §13.3, §14.2 | 採用 | key inventory、用途/環境分離、`openssl rand -base64 32`、wrangler secret、通常/緊急rotation、MFA/承認/監査を定義した。 |
| S3 | §8.1, §10.5, §13.3, §14.1, §15.2 | 採用 | share secretをfragment/POSTへ移しtoken pathを廃止。invocation URL記録を前提に全log surfaceをcanary検証し、raw request loggingを禁止した。 |
| S4 | §14.1, §15.2 | 採用 | `DEV_BYPASS_ACCESS`をproduction/staging configで拒否し、非developmentでは無視+warning、local adapter未登録とした。 |

## 7. §8 必須修正 P0 / P1

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| P0-01 | §4.1, §15.2 | 採用 | A1〜A3のheader-only JWT、user/service claim、route AUD、JWKS更新/失敗規則を確定した。 |
| P0-02 | §2.2, §4.2–4.3, §5.1 | 採用 | 全endpointをmanifestへ載せ、space owner / app admin / member /制限credentialを分離した。 |
| P0-03 | §3.2, §8.2, §12 | 採用 | 全readのspace-root祖先有効性を同期検査する。 |
| P0-04 | §4.4, §5.4, §11.3 | 採用 | Access、アプリ停止、app password、share、upload、jobの失効境界と最大遅延を定義した。 |
| P0-05 | §4.5, §5.1, §8.1–8.2 | 採用 | Cookie属性、token claim/用途、個別session、公開CSRFを表とAPIへ固定した。 |
| P0-06 | §10.4, §15.2 | 採用 | CONTENT_HOST/単一hostの安全な配信matrixを確定し、未許可active previewを無効化した。 |
| P0-07 | §8.1, §13.3, §15.2 | 採用 | URL capabilityを除去し、platform自動logを含むcanary非漏えい試験をrelease gateにした。 |
| P0-08 | §7.3, §15.2 | 採用 | 確定方針に基づくtoken semantics、MOVE時lock終了、strong ETag、If-Match範囲を統一した。 |
| P0-09 | §3.5, §4.4, §5.2, §11.3 | 採用 | 進行中HTTPのD1 epoch guardとbootstrap identity/一回性を確定した。 |
| P1-01 | §3.3, §7.2, §10.5, §13.1 | 採用 | bounded parserと出力先別encodingを数値付きで定義した。 |
| P1-02 | §4.5, §13.1, §14.2, §18.5 | 採用（KDF代替は後段gate） | entropy、KDF費用、通常/緊急key rotationを数値・手順化した。 |
| P1-03 | §2.2, §14.1, §14.3, §15.3 | 採用 | Bypass、全host/preview、Cookie、Access失効を実HTTP/実browserのstaging gateにした。 |

## 8. 追加セキュリティ受入試験

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| AT-01 | §15.2 | 採用 | wrong AUD/issuer/alg、未来時刻、未知kid連打、Cookie-only、user/service混同を追加した。 |
| AT-02 | §15.2 | 採用 | 別Access app、BypassへのJWT、CONTENT_HOSTからprivate API、alias/HTTP迂回を追加した。 |
| AT-03 | §15.2 | 採用 | `P/S/F`祖先trash直後のcontent/thumb/search/ZIP/media/ticket拒否を追加した。 |
| AT-04 | §15.2 | 採用 | credential失効/scope縮小後のupload/job/terminal result拒否と非開示を追加した。 |
| AT-05 | §15.2 | 採用 | 旧epoch HTTP mutationをrecovery後に再開するfailure injectionを追加した。 |
| AT-06 | §15.2 | 採用 | cross-origin、`Origin:null`、Fetch Metadata、Content-Type、CSRF再利用を追加した。 |
| AT-07 | §15.2 | 採用 | HTML/SVG/PDF/Markdown/filenameにarchive/EPUBを加え全surfaceと206/errorを検査する。 |
| AT-08 | §15.2 | 採用（確定方針の期待値） | 別principalのlock mutation/UNLOCK、MOVE後lock、strong/weak ETagの期待結果を明記した。 |
| AT-09 | §15.2–15.3 | 採用 | canary secretがWorkers Logs/Tail/Logpush/trace/WAF/error/D1 errorへ残らない試験を追加した。 |

## 9. 機能追加の反映箇所

| 機能追加 | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| 非目標 | §0.2, §18.7 | 採用（RAR/7z・波形等は後段） | OCR、DRM、RAR/7z、server EPUB変換、外部metadata、波形/歌詞同期をv1外へ固定した。 |
| メディアdata model | §3.1, §11.1 | 採用 | 指定8 tableすべてとpurge順、current blob/generation境界を追加した。 |
| Gallery API / UI | §5.1, §9, §9A.1, §13.1 | 採用 | recursive gallery、200件keyset、50,000候補、timeline/Lightbox/share viewを統合した。 |
| media metadata / thumbs | §9A.1, §10.1–10.3, §13.1 | 採用 | EXIF GPS破棄、sm/md/lg、lazy unique claim、outbox/generation/費用冪等を統合した。 |
| Bookshelf formats | §9A.2, §10.4, §18.7 | 採用（RAR/7zは後段） | EPUB、ZIP/CBZ、PDF、folder bookをv1、CBR/RAR/7zをunsupportedにした。 |
| archive index / zip bomb | §9A.2, §10.2, §13.1, §15.1 | 採用 | EOCD/central directory Range、path/method/entry/size/CRC上限とfailure testを追加した。 |
| archive page / thumb | §5.1, §9A.2, §10.2–10.4, §13.1 | 採用 | header+data Range、stored/deflate stream、page thumb並列4、ticket/CSPを統合した。 |
| EPUB reader | §9A.2, §10.4, §15.1–15.2 | 採用 | CONTENT_HOST sandbox、script禁止、TOC/theme/vertical writing/CFI stateを追加した。 |
| library metadata / tags / roots | §3.1, §5.1, §9A.2, §12 | 採用 | OPF/ComicInfo、user override、series/author/tag/read state、auto-index rootを追加した。 |
| Audio metadata job | §3.1, §9A.3, §10.2, §13.1 | 採用 | 対応codec/tag、head/tail/moov上限、1KiB field、cover再encodeを追加した。 |
| tracks API / audio override | §5.1, §9A.3 | 採用 | tracks最大2,000、folder album、Range content、immutable blobを保つmanual overrideを追加した。 |
| Audio UI / playback | §9, §9A.3, §12 | 採用 | mini-player、queue/repeat/speed/timer/MediaSession/seek/resumeとaudio searchを追加した。 |
| media認可 / share | §3.2, §4.3, §5.1, §8.2, §9A.4 | 採用 | gallery/tracks/libraryをmanifest、EffectiveLive、capability subtree、current blobへ統一した。 |
| Queue / outbox | §5.5, §9A.4, §10.1–10.2 | 採用 | index/tag/page thumb/searchをoutbox、epoch、saved principal、generation、result claimへ統一した。 |
| 制限 / 費用 | §13.1, §13.4 | 採用 | gallery、archive、audio、transformの数値上限とR2/D1/Images/Queueの費用単位を追加した。 |
| 実装phase / roadmap | §16, §17 | 採用 | `Media library: Gallery → Bookshelf → Audio` をv1 phaseとroadmapへ追加した。 |
