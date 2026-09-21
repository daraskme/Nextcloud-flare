設計書とラウンド3のレビュー・解決記録を読み、Cloudflare公式資料と必要に応じてworkerd実装を照合します。DDLは可能な範囲でSQLite検証し、確認済みの事実と「要確認」を分けて報告します。ファイルは編集しません。§13のWorkers Paid「サブリクエスト既定10,000」は、現在の公式資料と一致しています。一方、Queuesのメッセージサイズ単位、D1 batch全体の時間制限、multipartの最終partの扱いなどに補足が必要です。また、本文に実行可能なDDLとして載っているのは一部のテーブルだけで、FTS・commit barrier・主要状態テーブルの検証には未提示のSQLを区別する必要があります。SQLite 3.45.3のインメモリ検証では、掲載された14テーブルと2つの明示インデックスのCREATEは成功しました。ただし、そのDDLだけでは未定義の`trash_ops`への参照によりnode INSERTが失敗します。また、掲載インデックスでは削除済みnodeを含む子一覧が全表走査になります。

ライブラリ側では、通常の`hash-wasm`が実行時に`WebAssembly.compile()`を呼ぶ点と、`fflate`の非同期APIがWeb Worker／Node Workerを使う点がWorkersとの重要な不整合です。依存名だけで採用可とせず、使用APIと読み込み方式まで固定する必要があります。# ラウンド4 — Cloudflare制約・実装可能性レビュー

## 結論

**Cloudflare上での実現は可能です。ただし、v0.4をそのまま確定済みの実装契約としてSolへ渡せるか：No。**

主な理由はプラットフォーム選定ではなく、次の未確定・不整合です。

1. **`fsMutation`の原子性を担保する実SQLと、LockDO–D1間のfencingが未定義**
2. **UploadDO・trash・outboxの障害時状態遷移が不足**
3. **FTSを含むD1のバックアップ方式が未確定**
4. **一覧の件数上限とD1のqueries／rows read予算が接続されていない**
5. **通常の`hash-wasm`、`fflate`非同期APIにはWorkersとの不整合がある**
6. **CONTENT_HOSTへのticket搬送と、script禁止EPUB readerの成立条件が未確定**
7. **ラウンド3で意図的に残されたlock仕様は、依然としてRFC準拠のClass 2とはいえない**

一方、**R2ストリーミング、D1 batch、SQLite-backed DO、Queues、Images binding、Worker-first配信という基本構成は妥当**です。Foundationの検証実装には進めますが、下記P0事項を実装者の判断に委ねるべきではありません。

---

## 確認範囲・検証方法

- 確認日：**2026-09-21**
- 設計書全体とラウンド3レビュー・対応表を確認。
- Cloudflare公式ドキュメント、必要箇所のworkerdソース、ライブラリ上流ソースを照合。
- **SQLite 3.45.3の`:memory:`で、掲載DDL・制約・クエリ計画・関連SQL機能を実行検証**。
- リポジトリに実装・package manifest・migrationはなく、Workersへのデプロイ、Miniflare実行、本番相当負荷試験は未実施。
- workerdの`main`に存在する実装は、採用するWrangler版やCloudflare本番の設定値まで保証するものではありません。
- **対象ファイルは編集していません。**

対象：[DESIGN.md](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)  
参考：[round3-resolution.md](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/reviews/round3-resolution.md)

判定は以下の意味で使用します。

| 判定 | 意味 |
|---|---|
| **誤り** | 公式仕様・確認した実装・設計書内の別規定と不一致 |
| **要確認** | 実SQL、採用版、実環境測定、具体的なプロトコルが不足 |
| **妥当** | 記載された範囲で公式仕様と整合。性能保証を意味しない |

---

# 1. 制限値の再照合

## 1.1 Workers・D1

設計書の数値正本：[DESIGN.md:848-879](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

| 対象 | 設計 | 現行公式仕様・確認結果 | 判定／必要な修正 |
|---|---|---|---|
| HTTP request body | 95,000,000 bytes | Free／Pro 100 MB、Business 200 MB、Enterpriseはセルフサービスで最大5 GB。Workers Paidとは別の契約・zone設定。[W] | **妥当**。実zoneが95 MB未満へ制限されていないことは要確認 |
| 最大partとHTTP上限 | 90 MiB | 94,371,840 bytes。95,000,000 bytesまで628,160 bytesの余裕 | **妥当**。raw body前提。multipart/form-data化するなら追加サイズを計算 |
| URL・header | URL 8 KiB、header数100 | URL 16 KB、request／response headerはそれぞれ合計128 KB。[W] | **妥当／欠落**。header数だけでなく**合計bytes**も制限する |
| HTTP CPU | default 30秒、最大300秒 | Paidで一致。I/O待ちはCPU時間ではない。[W] | **妥当**。`limits.cpu_ms`を環境ごとに固定 |
| Worker memory | 128 MB | **isolate単位**。JS heap・WASMを含み、同時requestで共有。[W] | **妥当／重要な補足不足**。request単位の128 MBとして計算しない |
| subrequest | default 10,000 | Paidの現行既定値は10,000。設定上限は10,000,000。[W] | **妥当**。古い「Paidでも1,000」を一般上限として適用しない |
| outgoing connection | 6 | 現行公式説明では、応答headerを待っている初期接続を最大6件とする。[W] | **妥当／表現補足**。「開いたbody streamは全期間6本まで」とは異なる |
| response body | 明記なし | 強制サイズ上限なし。CDN cache上限は別。[W] | **欠落**。4 GiB未満ZIPはレスポンスサイズ上限では阻まれない |
| HTTP wall time | part 15分 | HTTPは接続継続中の固定wall上限なし。disconnect・runtime更新は別。[W] | **妥当**。15分はアプリ上限。完走保証ではない |
| `waitUntil` | 数値記載なし | HTTP応答完了／切断後、最大30秒延長。[W] | **欠落**。長時間upload完了処理やbackupの耐久実行基盤にはできない |
| D1容量 | 10 GB/DB | Paidで10 GB/DB、引き上げ不可。account既定合計1 TB。[D1L] | **妥当／欠落**。ユーザー数、90日分operation・audit・indexを含むDB全体予算が必要 |
| D1 queries | 1,000/invocation | Paidで一致。[D1L] | **妥当**。200件／2,000件を一件ずつ認可する実装とは分けて考える |
| D1 bind | 100 | **statementごと**に100。[D1L] | **妥当**。batch全体100ではない |
| D1 query時間 | 30秒 | 個別queryだけでなく、**batch call全体にも30秒**。[D1L] | **欠落**。statementごとの30秒を足し合わせられない |
| D1 SQL／row | 記載なし | SQL 100,000 bytes、文字列／BLOB／row 2,000,000 bytes、table列数100。[D1L] | **欠落**。8 MiB／16 MiB manifestを単一D1 rowへ置けない |
| D1関数・pattern | pattern 50 B | 関数引数32、LIKE／GLOB pattern 50 bytes。[D1L] | **妥当／欠落**。`%`やescape追加**後**のpatternを50 bytes以下にする |
| D1 Time Travel | 30日 | Paidで30日。restoreはDBごと10回/10分。[D1L] | **妥当**。外部exportの保持期間とは別 |
| bundle・Static Assets | 明記なし | 現行Workers上限は非圧縮64 MiB、startup 1秒。Paid assets 100,000 files、1 file 25 MiB。[W] | **欠落**。pdf.js・WASM・CMap等を含めbuild gateに追加 |

**注意：** 今回確認した公式資料では、Workersの一般subrequest上限は10,000へ更新されています。一方、D1は固有の1,000 queries制限を記載しています。両者を混同しないでください。

## 1.2 DO・Queues・Cron・R2・Images・KV

| 対象 | 設計 | 現行公式仕様・確認結果 | 判定／必要な修正 |
|---|---|---|---|
| SQLite-backed DO容量 | 記載なし | Paidは10 GB/object。row／key+valueは2 MB級、bind100、SQL100 KB。[DOL] | **欠落**。lock、permit、part、terminal保持の上限を追加 |
| 単一DO throughput | 記載なし | 単一thread、**soft limit 1,000 requests/秒**。処理内容次第で大幅に下がる。[DOL] | **要確認**。保証RPSとして使わない |
| DO CPU | 記載なし | default30秒、設定最大300秒。[DOL] | **欠落** |
| `blockConcurrencyWhile` | 記載なし | callbackは**30秒timeout**。超過・未処理例外でDO reset。[DOS] | **欠落**。CPU設定を300秒にしてもこの30秒は伸びない |
| DO alarm | 記載なし | 同時に一つ。at-least-once、失敗時2秒開始の指数backoff、最大6 retries。[DOA] | **欠落**。複数期限は最短期限へ集約、request時にもexpiry検査 |
| Queue message | **128 KiB** | 現行limitsは**128 KB、1 KB=1,000 bytes**、内部metadata約100 bytesも計上。[QL] | **誤り**。小さいID参照messageへ固定し、byte上限を別定義 |
| Queue batch | 100 | consumer最大100。`sendBatch`は最大100件**かつ合計256 KB**。[QL] | **欠落**。件数だけで分割しない |
| Queue retention | 14日 | Paidで最大14日、**既定4日**。[QC] | **要確認**。14日を必要とするなら明示設定 |
| Queue CPU／wall | wall15分 | wall15分、CPU既定30秒／最大300秒。[QL] | **妥当／CPU補足** |
| Queue並列・retry | app attempts3 | push consumer最大250並列、queue throughput5,000 messages/秒、retry設定最大100、delay最大24h。[QL] | **欠落**。app attempt3とdelivery retryを別カウンタにする |
| Cron | 3 schedule | UTC実行。Paidはaccountあたり250 triggers。wall15分。間隔1h未満はCPU30秒、1h以上は15分。[W][CRON] | **妥当**。掲載3式はいずれも1h以上。jobごとの小さいbudgetは別途必要 |
| R2 part数 | ≤10,000 | 一致。[R2L][R2U] | **妥当** |
| R2 part size | 8–90 MiB | 通常partは5 MiB–5 GiB。**最終part以外は同じsize、最終partは小さくてよい**。[R2U] | **補足必須**。「全part最低8 MiB」では小さいfile・最終partを扱えない |
| R2 file size | ≤500 GiB | multipartは約5 TiB級。64 MiBなら500 GiBは8,000 parts。[R2L] | **妥当**。R2 limits頁には端数注記の単位不整合があるが、500 GiBの可否には影響しない |
| incomplete multipart | 作成から6日 | R2既定auto-abortは7日、lifecycleで変更可能。[R2U] | **妥当**。実bucket設定と整合させる |
| 同一R2 key書込 | generation key | 同一keyへの同時書込は1回/秒が上限として記載。[R2L] | **欠落**。client thumb固定key・claim再試行でも429を扱う |
| R2 key／metadata | 明記なし | key1,024 bytes、metadata8,192 bytes。[R2L] | **欠落**。論理pathをkeyにしない方針は適合 |
| Images input | **20 MiB** | binding `.input()`は公式に**20 MB**。[IMG] | **要確認：単位差**。20 MiB=20,971,520 bytesを20 MBと同一視しない。安全側は20,000,000 bytes以下 |
| Images pixel／frame | 40 MP、1 frame | 40 MPはアプリ制限として妥当。ただし公式にはdimension・format・animation固有制約がある。[IMGL] | **要確認**。面積だけでは極端な縦長画像を制限できない |
| Images AVIF | page／image対象 | 現行formats頁はAVIF入力にEnterprise条件を記載。[IMGL] | **欠落**。ブラウザ表示対応とserver transform対応を分ける |
| KV size／rate | JWKS256 KiB等 | key512 B、metadata1,024 B、value25 MiB、同一key write1回/秒、`cacheTtl`最小30秒。[KVL] | **妥当／欠落**。JWKSは収まるがglobal single-flightはKVでは実現しない |
| KV consistency | 認可に使わない | eventual consistency。別拠点への反映は60秒以上かかる場合があり、negative lookupもcache。[KV] | **妥当** |
| KV call数 | 明記なし | KV limits頁は1,000/invocationと記載し、その脚注はWorkers共通10,000と不整合。[KVL][W] | **要確認**。KVは当面1,000以下で設計し、古い脚注を他binding全体へ拡張しない |

## 1.3 アプリ独自の数値上限

以下はCloudflareの保証値ではなく、アプリが実装・テストで強制する値です。

| 設計値 | 判定・実装上の条件 |
|---|---|
| JSON 1 MiB／深さ32、XML 1 MiB／深さ32／要素10,000／属性20,000／namespace100／property100 | **妥当な独自制限**。通常の`JSON.parse`やXML parserを呼ぶだけでは、parse中の各制限を満たさない |
| 名前UTF-8≤255 bytesかつ255文字未満、tree深さ64 | **妥当**。「文字」がUnicode scalarかUTF-16 code unitかを確定。casefold用列の長さも別途扱う |
| DAV If 8 KiB／16 lists・URI／64条件、Timeout≤604800 | **独自制限として妥当**。7日はCloudflareのlock上限ではない。client互換性は別検証 |
| PROPFIND response32 MiB、children2,000 | **要確認**。XML生成時の文字列・escape・D1結果の同時保持でメモリ増幅。件数分のD1／DO呼出しは禁止 |
| upload：24h無進捗／6日／3 attempts／calls≤parts×3／bytes≤declared×3／並列4／part15分 | **要確認**。control callとpart callを同じbudgetにすると、retry後にcomplete／abort用枠が残らない |
| physical headroom1.2、versions直近10または30日 | **要確認**。「10件または30日」が和集合か先到達か不明。reservation→physicalの台帳遷移も固定が必要 |
| backup5日／GC grace35日／RPO24h | **要確認**。保持方針として可能だが、export方式・journal保持・最古restore点との整合が必要。§11が参照するRTO値は§13にない |
| ticket6h／bytes×3／1,024 requests／並列8、unlock16、app password20／90–365日 | **独自制限として妥当**。EPUB・10,000ページarchiveではticket更新規則、disconnect後の並列枠回収が必要 |
| ZIP1,000 entries／payload<4 GiB／output≤UINT32_MAX／manifest8 MiB／GET≤1,000 | **妥当**。header・data descriptor・central directory全てを計上し、認可queryを集合化する |
| archive10,000 entries／entry64 MiB／合計8 GiB／CD8 MiB／EOCD1 MiB／name+extra64 KiB | **妥当な独自制限**。index JSON自体の最大bytes、safe integer、offset加算overflowも必要 |
| Gallery200件／候補50,000／深さ64 | **要確認**。返却200件はrows read200を意味しない |
| Audio2,000 tracks／head2 MiB／tail128 B／moov4 MiB／field1 KiB／cover20 MiB | **要確認**。2 MiBしか読まない契約と20 MiB cover抽出を接続する追加Range規則が必要 |
| WASM input8 MiB／12 MP、transform attempts3 | **要確認**。12 MPのRGBA一枚だけで約48 MB。入力・出力・作業領域・同時実行を含める |
| nodes200,000/user／COW refs1,000／dead props8 KiB/node・8 MiB/user | **独自制限として妥当**。user単位だけではD1全体10 GBを守れない |
| search候補10,000／bulk100,000 nodes・manifest16 MiB | **要確認**。候補件数と実scan量は別。manifestはR2等へ保存 |
| audit90日／R2 archive1年／operation・outbox90日compact | **要確認**。DB容量、復旧用journal、冪等再生可能期間と一体で設計 |
| JWKS1h／stale24h／timeout5秒／16鍵／10回/分／negative64件 | **独自制限として妥当**。issuer単位single-flight・10回/分の保存先と「1分cooldown」の関係を確定 |
| JWT24h／skew60秒／fresh iat5分、CSRF10分、rotation24h＋7日 | **アプリの認証方針**。Cloudflareの固定上限ではない。実Access設定とkey削除時刻の整合は要確認 |
| KDF600,000回／salt16 B／DK32 B／password1 KiB／10・30・600回/分／並列20 | **要確認・実装前gate**。後述のPBKDF2制限とisolateメモリ問題を解決する |

---

# 2. Binding APIの実在・意味論

**依頼に列挙されたAPIは、すべて現行のAPIとして存在します。**  
ただし、設計書に具体的な呼出しコードがないものは「APIがある」と「使い方を検証済み」を分ける必要があります。

| API | 判定 | 実装契約に追加すべき事項 |
|---|---|---|
| `R2Bucket.createMultipartUpload()` | **妥当** | 非同期。生成された`key/uploadId`を耐久保存してからpart受付。[R2API] |
| `resumeMultipartUpload()` | **妥当** | **同期的にhandleを作るだけ**。uploadの実在・active状態を検証しない |
| `uploadPart()` | **妥当** | `ReadableStream`対応。ただし長さ既知が必要。返った`partNumber/etag`を保存 |
| `complete()`／`abort()` | **妥当** | completeには保存済みpartsが必要。R2成功・応答喪失を照合する状態が必要 |
| multipart条件付き確定 | **要確認** | `complete()`に`onlyIf`はない。`createMultipartUpload()`にも通常putの条件付き書込と同じ保証を期待しない |
| `R2Bucket.put(...,{onlyIf})` | **妥当** | 条件不成立は**`null`**。例外だけで判定しない。R2条件はD1 revision CASの代替ではない |
| `R2Object.writeHttpMetadata(headers)` | **妥当** | 保存されたHTTP metadataを写すだけ。ETag、Range応答、認可、安全headerを自動構成しない |
| D1 `prepare().bind()` | **妥当／注意** | 公開API契約は`?`／`?NNN`。本文の`:request_epoch`をそのままnamed bindingとして実装しない。[D1P] |
| D1 `batch()` | **妥当** | transactionとして失敗時rollback。ただし**zero-rowは失敗ではない**。[D1API] |
| D1 Sessions API | **妥当** | `first-primary`は最初のqueryだけ。本文の注意は正しい。権威queryはSessionを使わない直接DBアクセスに固定するのが明快。[D1R] |
| DO `blockConcurrencyWhile()` | **妥当** | constructor初期化など短い区間用。upload body転送や長いD1処理待ちを囲まない |
| DO SQLite storage | **妥当** | `ctx.storage.sql.exec(sql,...bindings)`。D1の`prepare().bind()`とは別API。`transactionSync()`は同期callback専用。[DOSQL] |
| DO alarm | **妥当** | `storage.setAlarm()`＋classの`alarm()`。cronの代用品として無制限に複数登録できるわけではない |
| Queues `send/sendBatch` | **妥当** | `sendBatch`は`{body,...}`の配列等。成功はqueueへの耐久受付であってjob完了ではない。[QAPI] |
| Queues `ack/retry` | **妥当** | messageのmethod。D1結果確定後にack。delivery順序・exactly-onceは保証しない |
| Images `.input().transform().output()` | **妥当** | `output()`をawaitし、そのresultの`.response()`等を使う。`format`必須。R2の非公開bodyを入力できる。[IMG] |
| Rate Limiting `.limit({key})` | **妥当** | `{success}`を返す。**拠点ローカル・eventual・緩い制限**。global会計に使わない。現行設定は`ratelimits`で`unsafe.bindings`不要。[RL] |
| `ctx.waitUntil()` | **妥当** | HTTPの後処理は最大30秒。DOの`ctx.waitUntil`は現行説明では寿命延長効果なし。[CTX][DOS] |
| `assets.run_worker_first=true` | **妥当** | Worker認可後に`env.ASSETS.fetch()`。public未知routeをASSETSへ渡さない。[ASSET] |
| `scheduled(controller,env,ctx)` | **妥当** | Module Workerのexportに定義し、Honoの`fetch`・Queuesの`queue`と併設。[SCHED] |

### Wrangler例は配備可能な設定ではない

§14.1の例には、少なくとも次がありません。

- 必須の`compatibility_date`
- R2／D1／KV／DO／Queues／Images／Rate Limitingのbinding
- DOの`new_sqlite_classes` migration
- Queue consumerの並列・retry・DLQ設定
- 各environmentのresource IDとcustom domain
- CPU／subrequest budget

**概念例としては問題ありませんが、そのまま動く雛形として渡すのは不可**です。[WR]

また現行公式資料では、**compatibility dateが2026-08-04以降ならNode.js compatibilityは既定有効**です。「flagを省いたのでnodejs_compatなし」と判断できません。[NODE]

---

# 3. ストリーミングの成立条件

## 3.1 R2 → Response、Range

| 項目 | 判定 | 注意点 |
|---|---|---|
| `new Response(object.body, ...)` | **妥当** | R2 bodyを全メモリ化せず配信可能 |
| `get()`が`null` | **要実装** | object absentを処理 |
| conditional getでbodyなし | **要実装** | `R2Object`が返る場合を通常bodyありと区別 |
| single Range | **妥当** | R2の`range`を使用可能。ただしHTTPの206／416・`Content-Range`はアプリが構成 |
| HEAD | **妥当** | `head()`またはD1 metadataを使い、bodyを取得・消費しない |
| ETag | **要実装** | D1のcontent ETagとR2 ETagを混同しない。R2 ETagを使う場合は`httpEtag`が引用符付き |
| multi-rangeを無視して200 | **妥当** | 本文どおり全体size分のbudgetを先に確保する |
| content encoding | **要確認** | client由来の`Content-Encoding`を無検証で転記するとRange／sizeと不整合。byte-transparent配信条件を固定 |

## 3.2 `uploadPart(request.body)`は成立するが、途中変換に注意

workerdのR2共通実装は、streamの`tryGetLength()`が得られなければ次のエラーにします。

> `Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)`

確認したソース：[R2ストリーム長検査](https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/api/r2-rpc.c++)

したがって：

- 長さ既知のnative `request.body`を直接渡す：**成立**
- `request.body.pipeThrough(new TransformStream(...))`を渡す：**通常は長さ情報を失う**
- JS生成streamに単に`Content-Length`headerを付ける：**十分ではない**
- byte計数・hash・MIME sniffを挟む：**`FixedLengthStream(expectedBytes)`等で長さ契約を再構成する**

WorkersのRequest／Responseでは、手設定の`Content-Length`ではなく、body sourceの既知長が使われます。[RESP]

**提案文言：**

> part uploadはexpected sizeを受付前に確定する。byte計数・hash処理を挟む場合、R2へ渡すstreamはFixedLengthStream由来とする。producerとR2 consumerを並行開始し、双方成功後にのみpartを確定する。いずれか失敗時は両方向を停止し、partの結果を未確定として照合する。

先に`await body.pipeTo(writable)`してからR2へreadableを渡すと、**backpressureで停止**します。

## 3.3 TransformStreamは「identityしかない」ではない

公式TransformStream個別ページには古い説明が残っています。一方で：

- compatibility flagsでは、標準constructorが**2022-11-30から既定**
- workerdソースにはcustom transformer・backpressureを実装した標準経路がある

ため、現行compatibility dateで`new TransformStream({ transform() {} })`を使う方針は**妥当**です。[STREAM][COMPAT]

確認した実装：[workerd TransformStream](https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/api/streams/transform.c++)

ただし、**通常のTransformStreamとFixedLengthStreamは別物**です。

## 3.4 ZIP生成

STORE／non-ZIP64／全体4 GiB未満は実装可能です。ただし、設計には次の制御が必要です。

1. R2入力は逐次、または小さい固定並列で読む。
2. downstreamの`writer.write()`完了を待ってから次の入力chunkを読む。
3. `fflate`の`ondata`に`async`関数を渡しただけでは、fflate側がawaitしてくれるわけではない。
4. 1,000 objectを先読みする`Promise.all()`は禁止。
5. CRC32を逐次計算し、data descriptorを使用する場合はそのbytesも事前size計算へ含める。
6. disconnect時はR2 reader、ZIP producer、ticket並列leaseを終了する。
7. `tee()`の片側だけを先行消費しない。遅い側にfile全体がbufferされ得る。
8. manifest作成時から配信終了までblob pinを保持し、生成と配信の間のGC競合を閉じる。

**Workerのresponseサイズ制限は障害ではありません。主な制約はCPU、buffer量、subrequest、切断・再実行です。**

## 3.5 Archive展開

`DecompressionStream('deflate-raw')`はWorkersに存在し、ZIP deflate entryの逐次展開に使用できます。[WEB]

ただし、次を仕様化してください。

- local headerとcentral directoryのmethod／flags／name／size整合
- 暗号化entry・unsupported methodの拒否
- ZIP64整数のsafe integer検査
- 出力上限を**enqueue前**に検査
- CRC32の独立検査
- stream開始後のCRC不一致はHTTP statusを変更できず、stream errorにする
- 64 MiBを超える前に停止し、全体展開しない

本文の「開始前、またはstream error」は妥当ですが、**stream終端CRCを200開始前に必ず検証できるという意味にはできません**。

---

# 4. D1スキーマ・クエリ検証

## 4.1 SQLite実行結果

掲載された二つのSQLブロックを、FK有効のSQLite 3.45.3で実行しました。

| 試験 | 結果 | 判定 |
|---|---|---|
| 14テーブル・明示index2件のCREATE | 成功 | **妥当**。掲載DDLの構文エラーは確認されない |
| 掲載DDLだけでnode INSERT | `no such table: main.trash_ops` | **未完成**。`trash_ops`は説明だけでCREATEがない |
| 部分unique indexによるlive同名拒否 | 成功 | **妥当** |
| trash後の同名再利用 | 成功 | **妥当** |
| media/user stateの`ON DELETE CASCADE` | 成功 | **妥当** |
| root以外の`parent_id=NULL` | INSERT成功 | **制約不足** |
| 別spaceのparent指定 | INSERT成功 | **制約不足** |
| `TEXT PRIMARY KEY`へNULL | 複数行INSERT成功 | **制約不足**。`NOT NULL`または適切なSTRICT方針が必要 |
| 再帰CTE | 祖先走査成功 | **機能として妥当**。設計の完全なEffectiveLive SQLは未提示 |
| STORED生成列 | probe成功 | **機能として妥当**。設計書には生成列DDL自体がない |
| FTS5 external content | probe成功 | **機能として妥当**。実際のsearch schema／triggerは未提示 |
| top-level `DELETE … RETURNING` | 成功 | **妥当** |
| `WITH x AS (UPDATE … RETURNING …)` | syntax error | **使用不可**。PostgreSQL型のDML CTEでstep proofを組まない |
| variable limitを100に設定 | 100成功、101失敗 | D1制限に合わせた分割が必要 |

`trash_ops`の不足以降の制約試験では、**試験用の`trash_ops(id)`だけをインメモリ追加**しました。設計書の完全migrationが検証済みという意味ではありません。

### 制約としてまだ固定されていないもの

- rootだけparentなし
- 親が同一space・folder/root
- ownerとspace ownerの一致
- `current_blob_id`とblob ownerの整合
- blob size／ref_count／quota各値の非負
- root nodeの存在・一致
- `deleted_op_id`とtrash stateの整合
- operation step proof／commit barrier
- メディア結果のcurrent blob・generation一致

本文でmigrationへ委ねる方針は理解できますが、**この部分をLLMに設計させるなら、まだ「確定契約」ではありません**。

## 4.2 FK・生成列・FTS・RETURNING

| 項目 | 判定・注意 |
|---|---|
| D1 FOREIGN KEY既定 | **有効**。`PRAGMA foreign_keys=OFF`で回避する設計にはできない。必要なmigrationは`defer_foreign_keys`とtransaction終端で整合させる。[D1FK] |
| CASCADE | 利用可能。ただしquota・ref_count更新まで自動で行われるわけではない。大きいcascadeは同一queryの時間・書込budgetに入る |
| 生成列 | VIRTUAL／STOREDを利用可能。式は同一rowの決定的関数等に制限。既存tableへ`ALTER ADD`できるのはVIRTUAL。[GEN] |
| Unicode正規化 | SQLite `lower()`だけで設計のUnicode casefold・NFKC・かな統一を実装しない。applicationでversion固定した正規化値を保存 |
| FTS5 external content | 利用可能。**安定した整数rowid**とTEXT node IDの対応、insert/update/delete同期、rebuild手順が必要。[FTS] |
| bigram | FTS5が設計の日本語bigram tokenizerを標準提供するとはいえない。アプリで生成するtoken形式を固定する |
| RETURNING | top-levelで使用可能。trigger／cascadeの副作用件数を全て返すものではなく、結果は内部でbufferされる。大量`RETURNING *`は禁止。[RETURNING] |

## 4.3 bind100を超えやすい実装

実SQLが未提示なので、特定の既存queryが違反しているとは断定できません。ただし次の自然な実装は違反します。

| 処理 | 問題 |
|---|---|
| Gallery200件を`WHERE node_id IN (?,...)`で再取得 | 200 bind |
| tracks2,000件／PROPFIND2,000件を一つのINへ展開 | 2,000 bind |
| ZIP1,000 nodeのpinを一括VALUES | IDだけでも1,000 bind |
| PROPPATCH100 propertiesを3列VALUES | 300 bind＋共通条件 |
| bulk chunk100 nodesを各node数列でUPDATE／INSERT | 行数100とbind100は別 |
| 深さ64のsource・destination祖先IDを別々に列挙 | IDだけで128 bindになり得る |

**提案文言：**

> 各statementのbind数をSQL生成時に検査する。1行k bind、共通条件r bindならchunk件数をfloor((100-r)/k)以下とする。readのID集合にはsize-boundedなJSON＋json_eachも使用できるが、row／value・query時間制限を同時に守る。

atomicであるべきmutationを、bind上限対策だけで別batchに分けるのは不可です。

## 4.4 rows readとquery数

**§13.4の「Gallery page: D1 rows ≤200」は誤りです。**  
返却行数と、D1がscanした行数は異なります。[D1COST]

| 経路 | リスク | 必要な仕様 |
|---|---|---|
| live children | 掲載partial indexが使える | sort別のkeyset indexを確定 |
| trash／purge子一覧 | 今回の`EXPLAIN QUERY PLAN`では**`SCAN nodes`** | 削除済みも対象にする`nodes(parent_id, …)`等の非partial index |
| recursive Gallery50,000候補 | 各候補で最大64祖先なら、概算最大320万ancestor訪問＋join／sort | subtree集合CTE・認可を集合化し、実`rows_read`を測る |
| PROPFIND2,000件 | nodeごとEffectiveLiveを実行すると**1,000 queries/invocation超過** | 同一parentのlive確認＋集合取得。lockdiscoveryもDO一括照会 |
| search10,000候補 | global FTS後の認可filter、count／facetで大量scan | scope filter順、候補打切り、結果不完全時の応答を固定 |
| `%term%`／一文字fallback | LIMITがあっても走査量は抑えられない場合がある | 認可root内候補集合を先に制限 |
| FK cascade | FK参照側indexなしでは親削除ごとに子table scan | `user_*_state(node_id)`等、複合PKの先頭でない参照列にもindex |

またD1は**DB単位で単一thread**です。全利用者の認可をprimaryへ送る以上、LockDOより先に単一D1がボトルネックになる可能性があります。[D1L]

## 4.5 BackupとFTSの組合せ

公式のD1 exportには次の制約があります。[EXPORT]

- **virtual tableを含むDBのexportは未対応と記載**
- export中は他のDB requestをblock
- bindingの`dump()`は旧alpha DB向けであり、現行DBの一般backup APIではない

設計のwatermark＋journal方式は代替になり得ます。しかし次を確定する必要があります。

> backupはWorkersからのbounded logical exportとし、FTS virtual/shadow tableをbackup対象に含めない。正規化済みbase tableを復元後、FTSを再構築する。全書込・削除・認可状態変更を同一transactionのmutation journalに記録し、end watermarkまで適用してからbackup generationを公開する。

「Cronから日次D1 exportを呼ぶ」とだけ解釈して実装を始めるのは不可です。

---

# 5. Durable Objectsの成立性

## 5.1 単一LockDOの性能

**1 space＝1 LockDOは、個人向けストレージとして合理的です。ただし大量同期への上限は未定義です。**

`fsMutation`は少なくとも`inspect → beginCommit → endCommit`の3往復を示しています。soft limit1,000 DO requests/秒を単純に割っても、1,000 mutations/秒にはなりません。さらに短いcommit区間を直列化するなら、概ね次で制限されます。

```text
mutation throughput
  ≤ min(DO処理能力 / 1 mutationあたりDO呼出し数,
        1 / commit critical-section時間)
```

これは性能見積りの構造であり、保証値ではありません。

| 項目 | 判定 | 修正・受入条件 |
|---|---|---|
| PUT bodyをLockDOに通さない | **妥当** | 大容量R2 I/Oをreservation外に置く方針を維持 |
| 大量PROPFIND | **要確認** | 通常readをcommit queueへ入れない。2,000 childrenのlockdiscoveryを一件ずつRPCしない |
| 全space構造変更のtree generation CAS | **妥当／性能要確認** | 無関係folderでも競合する。bounded retryとretry exhaustion応答を固定 |
| DO storage10 GB | **概ね十分と推定、要確認** | lock数、permit履歴、terminal保持期間、SQLite rowサイズを数値化 |
| UploadDOの10,000 parts | **妥当** | partごとのrowに保存し、巨大な単一state JSONへ集約しない |
| singleton ControlDO | **要確認** | 全mutation・jobの集中点。LockDOだけでなくControlDOの負荷試験が必要 |
| TicketDO | **要確認** | disconnectでfinallyが走る保証はない。並列枠を耐久leaseとして期限回収 |
| global KDF DO | **要確認** | global permitとisolate内メモリ制御は別。DO内部で20件の重いKDFを同時保持しない |

## 5.2 `blockConcurrencyWhile`とin-flight barrier

設計書は`blockConcurrencyWhile`を使うと明記していません。実装者には、次を明示すべきです。

> blockConcurrencyWhileは初期化等の短い処理に限定する。R2転送、part15分待機、D1 batchの最大30秒待機を囲まない。in-flight状態・acceptParts・generationはSQLiteへ保存し、外部I/O後にCASする。

in-flightをメモリ上のカウンタだけで管理すると、DO reset後に：

- 本当はR2転送中なのにzeroと判断
- 永久に非zeroのままcomplete不能

のいずれも起こり得ます。

特に**同じpart numberへのretry競合**は、DOで世代を変えてもR2側にその世代条件を渡せません。旧転送が遅れてpartを上書きする問題を、同一part排他・同一内容検証・未確定転送の収束規則で閉じる必要があります。

## 5.3 eviction・alarm・stale

DOはdeploy／runtime更新／idle等で再起動し、shutdown hookを保証しません。[DOLIFE]

必要な契約：

- 永続stateから必ず再構成する。
- alarmは最短deadlineに設定し、処理後に次の期限へ再設定。
- alarmが遅れても、request時のexpiry検査で受付を止める。
- alarm retry枯渇後もCron repairで収束させる。
- R2操作の応答喪失を「未実行」と扱わない。

**特にLockDOのstale規則は修正必須です。**

現在は`LockDO(spaceId)`が旧epochを検出すると「全操作409」とするだけです。同じspaceIdからは同じDOへ行くため、**新epochの正当な利用まで永久拒否する実装が成立してしまいます**。

> UploadDOの旧sessionはstaleのまま終了する。一方LockDOはmaintenance下で旧lock／permitを無効化して新epochへ再初期化する、またはDO名にepochを含める。切替条件と旧permit拒否を明示する。

---

# 6. ローカル開発・CI・staging

§15.3の「Miniflareだけで合格にしない」は妥当です。ただし、現行環境では**ImagesもRate Limitingも一部ローカル検証可能**なので、「再現不可」と一括りにしない方が正確です。

| 対象 | ローカル／CIで確認可能 | ローカルだけでは保証できないもの |
|---|---|---|
| Access | fixture JWT、wrong issuer/AUD、route境界、fail-closed | IdP・MFA、edge policy、header付与、logout伝播、実Cookie |
| HTTP body／framing | アプリ95 MB制限、stream byte計数 | zone上限、edgeの重複CL／TE正規化、実client framing |
| Workers CPU／memory | bounded algorithm、slow consumer、cancel伝播 | production enforcement、同時isolate負荷、runtime更新中断 |
| D1 | migration、batch rollback、FK、FTS、SQL機能 | replica lag、実30秒上限、overload、Time Travel、実rows read／性能 |
| R2 | multipart・Rangeの基本API | 強整合の実運用、同一key rate、lifecycle、各応答喪失 |
| DO | SQLite、state transition、alarm handler、reset相当fault injection | 配置・eviction・overload・version混在の実挙動 |
| Queues | producer→consumer、ack／retry、duplicateの注入 | **consumer concurrencyはローカル未対応**。`wrangler dev --remote`もQueues未対応。[QLOCAL] |
| Images | offline版のwidth／height／rotate／format、Vitest | 全codec、全transform、metadata除去、20 MB境界、実サービス負荷 |
| Rate Limiting | local simulationで分岐・key・429処理 | 複数PoP・複数isolateでの緩い整合性。remote binding非対応 |
| Cron | `scheduled`の明示呼出し | 実scheduler、伝播遅延、実行重複／job競合 |
| browser／DAV | Playwright相当、litmus、rclone等の自動試験 | Finder／Explorer実機、opaque origin・Cookie制約のbrowser差 |

現行Imagesは、localの低忠実度版とremoteの高忠実度版があります。[IMG]  
またlocal Workerに`images.remote:true`を設定する方式があり、QueuesのためにWorker全体を`--remote`へ切り替える必要はありません。[LOCAL]

### CIを三段階に分ける提案

1. **資格情報不要のCI**
   - lint、typecheck、build
   - Workers Vitest integration
   - D1 migration・SQL・DO・Queue duplicate・stream backpressure
   - parser fixture、認可表、state machine、manifest negative tests

2. **承認付きstaging CI**
   - 分離resourceへdeploy
   - Access／Images／R2／D1／Rate Limitingの実境界
   - KDF対応・CPU測定
   - restore drill、費用・rows read計測

3. **release前の実client gate**
   - Finder／Explorer／rclone
   - browser別reader・media・Cookie・Range
   - credential／ticketがplatform logへ残らないcanary

**§15には、KDF API上限、Rate LimitingのPoP差、同一space同期負荷、D1 query数、alarm retry枯渇を明示追加すべきです。**

---

# 7. 実装契約として不足する箇所

## 7.1 `fsMutation`疑似コード

対象：[DESIGN.md:488-550](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

### A. commit barrierのSQLがない

`finalBarrierRequiring...()`という関数名だけでは原子性を証明できません。

今回のSQLite probeでも：

- 先行UPDATE
- `INSERT … SELECT … WHERE false`

は、後者がzero-rowでも先行UPDATEをcommitしました。

一方、**無条件に実行するbarrier INSERT＋`RAISE(ABORT)` trigger**では全体rollbackを確認しました。

**提案文言：**

> final barrierは条件不成立時にzero-rowとなるstatementではなく、必ず実行され、proof・credential・epoch・fence不成立時にSQL errorを起こす。全stepの成功証明は同一batch内で作成し、JSの結果件数検査をrollback根拠にしない。

### B. batch成功後の例外をrollback失敗と同じcatchに入れている

`assertEveryReturningCount()`と`readCommittedResultPrimary()`は、batchがcommitした後に失敗し得ます。

そこで無条件に`recordFailedClaimCompensation()`すると、**commit済みoperationをfailed扱いし、公開済みblobをGC候補にする**実装になり得ます。

> batch失敗とcommit結果不明を区別する。timeout・応答喪失・commit後read失敗はprimaryでoperationを照合し、rollback確認前に補償しない。committedはfailedへ変更しない。

### C. `claimOperation()`と`insertClaim()`の役割が不明

- 二回INSERTするのか
- 外側claimを予約として使うのか
- competing retryを待たせるのか
- abandoned claimをいつ回収するのか

を決める必要があります。現在はR2失敗等が`try`の外にあり、claimedのまま残る場合もあります。

### D. LockDO reservationはD1 transactionと原子的ではない

想定される反例：

1. Worker Aがpermit取得
2. AがD1送信前後で停止
3. LockDOがreset／permit期限切れ処理
4. Worker Bへ交差LOCKを許可
5. Aの古いD1 batchがcommit

D1内に古いpermitを排除する権威的なfenceがなければ、DOのgenerationだけでは閉じられません。

> permitの期限切れ・再発行・LOCK公開は、旧D1 commitを不可能にするfence更新、または旧operationの収束確認を伴う。曖昧なD1結果のままpermitを解除しない。

### E. MOVEのlock終了を「commitと同時」にする方式がない

D1とDOをまたぐ分散transactionはありません。

- D1にlock invalidation intentを同時記録
- LockDOでpending invalidationを耐久化
- 新しいlock照会・grant時にD1結果と照合

等の具体的な可視性規則が必要です。

### F. recoveryのquiesce完了条件がない

D1 restoreは`control.epoch`も巻き戻します。restore後のepoch再設定までの間に旧requestを通さないため、**「quiesceした」ことの判定条件**を定義してください。

単にControlDOをmaintenanceにしただけでは、既に認証・受付済みのHTTP requestは止まりません。

---

## 7.2 `authorize`判定表

表の方向性は良いですが、以下は実装者の裁量が残ります。

| 曖昧な記述 | 固定すべき文言 |
|---|---|
| 「support policyが許す時だけ」 | v1ではapp_adminの他者file readを禁止する、または具体的なsupport grantを定義 |
| 「明示grant」「admin scope」「専用admin scope」 | grant／scope enumと各operationへの対応表を定義 |
| create／write／MOVE／deleteを一行 | source、source parent、destination parent、overwrite targetそれぞれの必要権限を操作別に列挙 |
| `Authorized<Operation, typeof operands>` | Operationごとのoperand tuple型を定義。一般的な`Operand[]`では必須operand欠落を型で防げない |
| terminal replay | 成功／失敗で開示するfield、result nodeがpurge済みの場合、credential再発行後の扱いを固定 |
| jobのsaved principal | client JWT寿命終了と、アプリcredential／grant失効を分離。system repair／GC用principalの権限も定義 |
| `public/share`、`...`を含むroute表 | concrete method＋template＋request／response schemaへ展開 |
| public multipart part | binary PUTに適用するOrigin／CSRF／Content-Type規則を、JSON mutation規則から分離 |
| internal shareはrestore後自動復活しない | 非同期`disabled_reason`だけに依存せず、restore時点までに有効な失効記録を保証 |

型や「全handlerがauthorizeを呼ぶ」静的検査は補助であり、**認可の意味的な正しさを証明するものではありません**。

---

## 7.3 状態機械

対象：[DESIGN.md:559-576](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

| 対象 | 問題 | 必要な確定仕様 |
|---|---|---|
| UploadDO | terminal列挙に`stale`がない | staleをstateにするか、終端reasonにするか統一 |
| `initiating` | quota予約後・R2 create後・uploadId保存前の各失敗が未定義 | 各副作用の順序、retry key、orphan回収、reservation解放を列挙 |
| `completing` | R2成功・D1未確定の中間状態が見えない | R2完成確認済みflag／substate、physical charge、D1 result照合を分ける |
| abort／expire | terminal化とR2 abort成功・課金解放の関係がない | cleanup pendingを耐久記録し、terminalでもcleanup retry可能にする |
| 同一part retry | 後着の旧uploadが新partを上書きし得る | 同一part排他、attempt ID、body identity、未確定I/Oの収束規則 |
| `trash_ops` | §3.1 state一覧に**`removed`がない**が§5.5で使用 | **誤り**。`restored`等へ統一するかrow削除を明記 |
| restore | chunk中にrootをlive化する時点が不明 | 全子孫処理・失効処理完了後、最後のbatchでroot公開 |
| purge | 「safe root」がschemaにない | 非公開staging parentの実体・権限・名前衝突規則を定義 |
| GC | `candidate ↔ pinned`だけでは複数pinを表現できない | 独立pin rowsを権威にし、zero refs／pins確認と`deleting`遷移を同一batchにする |
| outbox | `dispatching→sent`前にconsumerが完了し得る | producerはcompletedをsentへ戻さない。dispatch lease切れ・再送・consumer先行を定義 |
| derivative claim | lease切れ後の旧workerが結果を書く | claim token/fence付き公開CAS。R2 result keyもretryによる上書きを防ぐ |
| job lease | HTTP／D1結果不明時のlease回収 | checkpoint・fence・副作用を同一batchにする |

### UploadDOの推奨契約

単にstate名を追加するより、各遷移に以下の列を持つ表が必要です。

```text
from / event / guards / D1 effects / DO effects / R2 effects
/ retry behavior / response-loss recovery / quota delta / to
```

特に：

> R2 complete成功を確認してもD1 commit未確定なら、upload成功を返さない。再実行時は不変keyのHEAD・metadata・sizeとoperationを照合する。R2上に完成objectが存在しない場合だけcomplete再試行を検討し、resume handle作成を実在確認としない。

なお、**Workers R2 bindingにはS3の`ListParts`相当APIが掲載されていません**。part一覧復元を暗黙にR2へ任せず、DO保存と同一part再送で回復できる契約が必要です。

---

## 7.4 WebDAVのXML例は不足

設計書にはXML入出力fixtureがありません。少なくとも次を規範例にしてください。

- PROPFIND：空body／allprop／propname／指定prop
- 同一response内の200 propstatと404 propstat
- collection末尾slash、percent-encoded href、XML escaping
- PROPPATCH：document order、失敗propertyと424、全体rollback
- LOCK：既存resource200／未作成resource201
- refresh：bodyなしrequest、更新後lockdiscovery
- UNLOCK204
- 423＋`lock-token-submitted`
- Depth infinity拒否＋`propfind-finite-depth`
- COPY／MOVEのOverwrite、Depth、部分失敗応答

例えば、fixtureでは次の区別を固定する必要があります。

```xml
<D:multistatus xmlns:D="DAV:" xmlns:X="urn:example:props">
  <D:response>
    <D:href>/dav/a%20b.txt</D:href>
    <D:propstat>
      <D:prop>
        <D:displayname>a b.txt</D:displayname>
        <D:getetag>"blob-etag"</D:getetag>
      </D:prop>
      <D:status>HTTP/1.1 200 OK</D:status>
    </D:propstat>
    <D:propstat>
      <D:prop><X:missing/></D:prop>
      <D:status>HTTP/1.1 404 Not Found</D:status>
    </D:propstat>
  </D:response>
</D:multistatus>
```

`D:`というprefix文字列ではなく、**namespace URI＋local name**で解釈する必要があります。

### Class 2の判定は、ラウンド3対応表と一致しない

対応表は「確定方針」として、他principalによる通常locked mutationを許しています。しかし[RFC 4918 §6.4](https://www.rfc-editor.org/rfc/rfc4918.html#section-6.4)は：

> `MUST check that the authenticated principal matches the lock creator`

と明記しています。

したがって判定は**誤り：RFC準拠という主張との不一致**です。

選択肢は二つです。

1. Class 2を維持し、通常locked mutationにもcreator一致を要求する。
2. 独自token委譲方針を維持し、無条件のRFC Class 2準拠表記を外す。

「前ラウンドで採用済み」で解決したことにはなりません。

またlarge folder COPY／cross-owner COPYをREST jobへ逃がす方針と、同期WebDAV COPYの完了応答の関係も未定義です。DAV clientへjob IDを返して同等互換とすることはできません。

---

## 7.5 CONTENT_HOST・EPUB・共有UIの実装矛盾

これはCloudflare APIの問題ではありませんが、実装を止める境界です。

### Ticketの搬送経路

設計はticketをURLへ置かず、Cookie欄も「なし」としています。一方：

- `<audio src>`
- `<video src>`
- `<img src>`
- `<iframe src>`
- EPUB内のCSS／image／font

には、通常任意のAuthorization headerを付けられません。

**要確認：** Fetch＋blob URL、限定content-session Cookie、別の安全な搬送方式のどれを採用するかを確定してください。500 GiB fileを全体blob化する案は不可です。

### script禁止EPUB reader

現在の`CSP sandbox`には`allow-scripts`も`allow-same-origin`もありません。

そのままでは：

- iframe内scriptからのpostMessageはできない
- cross-origin親がDOMを操作してCFI・paginationを実装できない
- sandboxのopaque originではmessage originを通常のCONTENT_HOST文字列と比較できない
- `style-src 'unsafe-inline'`だけでは外部EPUB CSSを許可しない
- `font-src`がなく、同梱fontも`default-src 'none'`で拒否される

**誤り：現在のCSPとreader機能要件はそのままでは両立しません。**

「出版物由来scriptは禁止、信頼済みreader shellだけ限定許可」等へ分離するか、v1 readerの機能を縮小する必要があります。

### 共有landingのJS

private assetsはAccess必須ですが、share landingはfragmentをJSで読む設計です。**匿名share用の公開JS/CSS配信経路**をmanifestに定義してください。private SPA assetをそのまま読み込ませるとAccessへ誘導されます。

---

## 7.6 実装フェーズの粒度・依存順序

現在の10フェーズは、**ロードマップとしては妥当、単一実装者へ渡す一作業単位としては大きすぎます**。

| Phase | 分割・先に確定すべき事項 |
|---|---|
| 1 Foundation | ①runtime／binding spike、②完全migration、③primary DB adapter、④認可表、⑤単一mutation SQL、⑥barrier／fence障害試験へ分割 |
| 2 Files core | create、overwrite、rename／MOVE、same-owner COW、cross-owner copyを別deliverableにする。cross-owner copyはmultipart／pins／job基盤に依存するため後へ |
| 3 Multipart | create予約、part streaming、status／resume、complete reconciliation、abort／expiryを分割。小file・zero-byteも仕様化 |
| 4 Trash／GC／recovery | trash、restore、purge、GC、logical backup、restore drillを独立させる。最も大きいphaseの一つ |
| 5 Search／stats | FTS schema／tokenizer、scope-aware query、keyset index、count／facet、集計整合性を別々に固定 |
| 6 Thumbnail／preview | outbox基盤はFiles coreより前に必要。Images有無、client thumb CAS、delivery matrix、ticket搬送を分割 |
| 7 Sharing | token／unlock、internal grant、upload-only、public edit、content ticket、ZIPを分割。public upload実装より前に認可契約が必要 |
| 8 WebDAV | Class 1 method群、XML property model、条件header、lock protocol、実client試験へ分割。LockDO coreはPhase1へ前倒し |
| 9 Media | Gallery、archive index、CBZ reader、EPUB reader、PDF integration、audio tag parser、playerを独立phaseにする |
| 10 Operations | DLQ・repair・capacity・restore監視はpolishではなく先行基盤。i18n／PWA／a11yと分離 |

§16の「Foundationと§15 failure gateが通るまでFiles coreへ進まない」は、§15全体を意味すると循環します。§15にはmultipart・WebDAV・media等の後続機能が含まれます。

**提案文言：**

> 各phaseの完了条件は、そのphaseが導入する不変条件と、既存phaseに対する回帰試験とする。FoundationではSQL barrier、認可、epoch、fenceの最小fixtureを必須とし、未実装surfaceのrelease gate全件通過は要求しない。

---

# 8. 依存ライブラリ

まず、v0.4本文に明記されるのはHono、fast-xml-parser、pdf.js、React系等です。**`zod-openapi`、`fflate`、`hash-wasm`は本文に明記されておらず、package manifestもありません。** 以下は依頼で挙げられた採用候補としての評価です。

| ライブラリ | Workers適合性 | 制約・判断 |
|---|---|---|
| Hono | **妥当** | Workers対応が公式にある。upload経路でJSON／body parser middlewareを通して全body消費しない。DAVの独自methodをmanifestから登録。[HONO] |
| `@hono/zod-openapi` | **妥当／版要確認** | Workers entrypointを公式に案内。`zod-openapi`という別packageとの混同を避ける。Hono／Zodとの互換版を固定。[ZOD] |
| fast-xml-parser | **利用可能、設定不足** | JS実装として使用可能。ただし`processEntities:false`だけではDTD拒否・namespace解決・全budget制御を満たさない |
| fflate | **同期streamは妥当、非同期APIは不可** | `Zip`＋`ZipPassThrough`等は利用候補。`Async*`／非同期zip等はWeb Worker／Node Workerを使用し、通常Workersでは成立しない。[FFLATE][WASM] |
| hash-wasm | **通常loaderの無変更採用は誤り** | 上流loaderはbase64 decode後に`WebAssembly.compile()`する。Workersの通常実行時制約に抵触。`nodejs_compat`では解消しない。[HASH][WEB] |
| pdf.js／`pdfjs-dist` | **browser利用は妥当** | 本文のclient描画は正しい。server側Canvas／DOM／Web Workerを期待しない。`pdf.worker.mjs`・CMap等を同梱し、Range／認証／CSPを調整。[PDF] |
| React／Router／Query／Virtual／shadcn/ui | **SPAとして妥当** | DOM・browserで実行。Vite／Tailwindはbuild時Nodeで実行するもので、Worker内で動かす必要はない。SSRを後付けすると別評価 |

### fast-xml-parserの追加条件

上流実装では`processEntities:false`はentity変換を無効にします。したがって、`&amp;`等を含む正当なproperty値を、後段でそのままescapeし直して壊さない規則が必要です。

また既定では：

- `preserveOrder:false`
- `ignoreAttributes:true`
- `parseTagValue:true`
- `trimValues:true`

です。

WebDAV dead propertyのmixed content・namespace・空白・document orderにそのまま使用できません。**DTD拒否、XML標準entityのdecode、namespace対応、order保持、数値自動変換禁止、depth／要素／属性予算**をまとめたadapter契約が必要です。

確認した上流：[OptionsBuilder](https://raw.githubusercontent.com/NaturalIntelligence/fast-xml-parser/master/src/xmlparser/OptionsBuilder.js)、[XMLParser](https://raw.githubusercontent.com/NaturalIntelligence/fast-xml-parser/master/src/xmlparser/XMLParser.js)

### hash-wasmの代替

用途によって選択してください。

- streaming SHA-256：`node:crypto.createHash()`、またはWorkersの`crypto.DigestStream`
- WASM実装が必要：build時にmoduleとして同梱し、既compiled moduleをinstantiateするadapter
- multipart全体hash：各part hashの連結をfile SHA-256と呼ばない。順序付き全内容hashの生成方式を別定義

### PBKDF2 600,000回は「ローカルで通れば本番も通る」ではない

workerdソースでは：

- 基底limit enforcerに**100,000 iterations**の既定
- standalone serverの`NullIsolateLimitEnforcer`はPBKDF2上限なし
- WebCrypto実装はそのenforcerを呼び出す

という差を確認しました。

資料：[limit-enforcer.h](https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/io/limit-enforcer.h)、[standalone server](https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/server/server.c++)、[PBKDF2実装](https://raw.githubusercontent.com/cloudflare/workerd/main/src/workerd/api/crypto/pbkdf2.c++)

**Cloudflare本番の採用enforcerが600,000回を許すかは要確認です。**  
公開ソースの既定100,000だけから本番を断定することも、standalone成功だけから本番対応を断定することもできません。

したがって§18の「latencyを測る」に加え、**APIがパラメータを受理するかを最初のgate**にしてください。未確認なら共有password機能を有効にしない方針が必要です。

scrypt代替も、`N=2^15,r=8,p=1`では主要作業領域だけで約32 MiBです。global同時20という制限は、128 MB/isolateを守る保証になりません。`maxmem`とisolate内同時数を別に固定してください。

---

# 9. 実装前の修正リストと最終判定

## 必須修正

| 優先 | 修正事項 | 完了条件 |
|---|---|---|
| **P0** | 完全なD1 migration・step proof・final barrier SQL | 全zero-row、constraint failure、claim競合で副作用ゼロを実D1 batchでも確認 |
| **P0** | `fsMutation`のcommit結果不明・補償・LockDO fencing | D1成功応答喪失、permit期限切れ、DO reset、旧request再開でも二重確定・lock違反なし |
| **P0** | UploadDOの副作用付き状態遷移 | part retry、complete応答喪失、abort／expire、課金、R2実在照合が収束 |
| **P0** | `trash_ops`のstate不一致とrestore／GC境界 | `removed`等を統一し、公開時点・pin・deleting不可逆点をSQLで固定 |
| **P0** | CONTENT_HOST ticket搬送・EPUB readerの実行モデル | URL secret禁止とnative media／iframeを両立するbrowser実証、CSP fixture |
| **P0** | WebDAV Class 2方針 | creator一致を採用するか、独自仕様として準拠表記・受入期待値を変更 |
| **P0** | KDFとWASM／fflate採用方式 | 固定runtime・固定packageでstaging smoke test。標準hash-wasm loader／fflate Async依存を残さない |
| **P0** | FTSを含むbackup／restore仕様 | logical export対象、journal完全性、FTS再構築、epoch再設定、restore drill |
| **P1** | Queues単位、Images bytes、各固有限界を修正 | bytes値・設定値・error mappingの一元化 |
| **P1** | 一覧・search・PROPFINDの実SQL／index | query数・bind数・rows read・durationのfixture別budget |
| **P1** | DO容量・throughput・alarm・stale再初期化 | 同一space同期負荷、alarm retry枯渇、restart、並列枠リーク試験 |
| **P1** | 完全route manifestとXML入出力例 | `...`や曖昧なscopeがなく、negative testを機械生成可能 |
| **P1** | 実装phaseの分割と依存順序修正 | 各phaseが単独でmigration・unit・integration・rollback検証可能 |

## 総合判定

| 観点 | 判定 |
|---|---|
| Cloudflareサービス選定 | **妥当** |
| 列挙binding APIの実在 | **妥当** |
| R2大容量pass-through／multipart | **妥当。ただし既知長・障害回復契約が必要** |
| 現行platform数値 | **概ね妥当。一部誤り・重要な欠落あり** |
| D1掲載DDLの構文 | **妥当** |
| D1完成schema・mutation原子性 | **要確認：実装契約未完成** |
| 単一LockDO／D1の性能 | **要確認：実SQL・負荷条件が不足** |
| ローカル／stagingの分離方針 | **妥当。追加gateが必要** |
| 依存ライブラリ | **一部誤り。使用API・loader・版の固定が必要** |
| WebDAV Class 2表記 | **誤り：現在のlock creator規則とは両立しない** |
| EPUB／CONTENT_HOST | **現仕様のままでは不成立・未確定** |
| Solへの確定仕様としての引き渡し | **No** |

**推奨する次の一歩は、機能実装ではなく「Phase 0：runtime・SQL・stream・fenceの実証」と「P0仕様の確定」です。**  
これを通過すれば、全体アーキテクチャを変更せずに、細分化したフェーズで一人の実装者へ引き渡せます。

---

## 主な一次資料

[W]: https://developers.cloudflare.com/workers/platform/limits/
[D1L]: https://developers.cloudflare.com/d1/platform/limits/
[D1API]: https://developers.cloudflare.com/d1/worker-api/d1-database/
[D1P]: https://developers.cloudflare.com/d1/worker-api/prepared-statements/
[D1R]: https://developers.cloudflare.com/d1/best-practices/read-replication/
[D1FK]: https://developers.cloudflare.com/d1/sql-api/foreign-keys/
[D1COST]: https://developers.cloudflare.com/d1/platform/pricing/
[GEN]: https://developers.cloudflare.com/d1/reference/generated-columns/
[EXPORT]: https://developers.cloudflare.com/d1/best-practices/import-export-data/
[FTS]: https://sqlite.org/fts5.html
[RETURNING]: https://sqlite.org/lang_returning.html
[DOL]: https://developers.cloudflare.com/durable-objects/platform/limits/
[DOS]: https://developers.cloudflare.com/durable-objects/api/state/
[DOSQL]: https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/
[DOA]: https://developers.cloudflare.com/durable-objects/api/alarms/
[DOLIFE]: https://developers.cloudflare.com/durable-objects/concepts/durable-object-lifecycle/
[R2L]: https://developers.cloudflare.com/r2/platform/limits/
[R2API]: https://developers.cloudflare.com/r2/api/workers/workers-api-reference/
[R2U]: https://developers.cloudflare.com/r2/objects/upload-objects/
[QL]: https://developers.cloudflare.com/queues/platform/limits/
[QC]: https://developers.cloudflare.com/queues/configuration/configure-queues/
[QAPI]: https://developers.cloudflare.com/queues/configuration/javascript-apis/
[QLOCAL]: https://developers.cloudflare.com/queues/configuration/local-development/
[IMG]: https://developers.cloudflare.com/images/optimization/binding/
[IMGL]: https://developers.cloudflare.com/images/get-started/limits/
[KVL]: https://developers.cloudflare.com/kv/platform/limits/
[KV]: https://developers.cloudflare.com/kv/concepts/how-kv-works/
[RL]: https://developers.cloudflare.com/workers/runtime-apis/bindings/rate-limit/
[CTX]: https://developers.cloudflare.com/workers/runtime-apis/context/
[ASSET]: https://developers.cloudflare.com/workers/static-assets/routing/worker-script/
[SCHED]: https://developers.cloudflare.com/workers/runtime-apis/handlers/scheduled/
[CRON]: https://developers.cloudflare.com/workers/configuration/cron-triggers/
[STREAM]: https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/
[COMPAT]: https://developers.cloudflare.com/workers/configuration/compatibility-flags/
[RESP]: https://developers.cloudflare.com/workers/runtime-apis/response/
[WEB]: https://developers.cloudflare.com/workers/runtime-apis/web-standards/
[WASM]: https://developers.cloudflare.com/workers/runtime-apis/webassembly/
[NODE]: https://developers.cloudflare.com/workers/runtime-apis/nodejs/
[LOCAL]: https://developers.cloudflare.com/workers/local-development/
[WR]: https://developers.cloudflare.com/workers/wrangler/configuration/
[HONO]: https://hono.dev/docs/getting-started/cloudflare-workers
[ZOD]: https://hono.dev/examples/zod-openapi
[FFLATE]: https://raw.githubusercontent.com/101arrowz/fflate/master/README.md
[HASH]: https://raw.githubusercontent.com/Daninet/hash-wasm/master/lib/WASMInterface.ts
[PDF]: https://mozilla.github.io/pdf.js/getting_started/

- Workers：[制限][W]／[compatibility flags][COMPAT]／[Wrangler][WR]／[ローカル開発][LOCAL]
- D1：[制限][D1L]／[binding API][D1API]／[FK][D1FK]／[export制約][EXPORT]／[課金rows定義][D1COST]
- Durable Objects：[制限][DOL]／[concurrency][DOS]／[SQLite][DOSQL]／[alarm][DOA]
- R2：[制限][R2L]／[binding API][R2API]／[multipart][R2U]
- Queues：[制限][QL]／[設定][QC]／[API][QAPI]／[ローカル制約][QLOCAL]
- Images：[binding][IMG]／[形式・制限][IMGL]
- KV：[制限][KVL]／[整合性][KV]
- その他：[Rate Limiting][RL]／[Static Assets][ASSET]／[Cron][CRON]／[Workers Vitest integration](https://developers.cloudflare.com/workers/testing/vitest-integration/)
