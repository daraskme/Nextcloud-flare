# Astra ラウンド4 指摘対応表

対象: `docs/DESIGN.md` v0.5

- 判定は「採用」「不採用」「後段」。一部を staging gate に送ったものは「採用（実測は後段）」とする。
- ラウンド4の §1〜§9 と P0/P1 を全件追跡する。
- review提案と改訂依頼の確定方針が衝突する場合は、確定方針を優先し、不採用理由を明記する。

## 1. 制限値（レビュー §1.1〜1.3）

| 指摘 (節番号 + 要旨) | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| §1.1 HTTP body 95,000,000Bはzone plan依存 | §13.1–13.2, §15.2, §18 | 採用（実測は後段） | 公式100/200MB等とapp 95,000,000Bを分離しzone gateを置いた。 |
| §1.1 90MiB partとbody余裕、form-data overhead | §6.1, §13.2 | 採用 | raw binary bodyに固定し、非最終8–90MiBとした。 |
| §1.1 URL 16KB、header合計128KBの欠落 | §13.1–13.2 | 採用 | 公式値を脚注化し、appはURL8KiB/header合計64KiB/100個へ縮小。 |
| §1.1 Paid CPU 30s/300s | §13.1, §14.1 | 採用 | `limits.cpu_ms=300000`を固定した。 |
| §1.1 memory 128MBはrequestでなくisolate単位 | §13.1, §14.2 | 採用 | isolate共有を明記し、KDFはinstance内1件にした。 |
| §1.1 subrequest 10,000、D1固有1,000との区別 | §13.1, §15.1 | 採用 | 別行の正本とquery予算へ分離した。 |
| §1.1 outgoing connection 6の意味 | §13.1 | 採用 | 初期接続待ち6として記載した。 |
| §1.1 response bodyに強制size上限なし | §13.1, §10.2 | 採用 | ZIPはresponse上限でなくCPU/memory/backpressureを制約にした。 |
| §1.1 HTTP固定wall無し、15分はapp上限 | §13.1–13.2 | 採用 | platformとpart app deadlineを分離した。 |
| §1.1 waitUntil最大30秒 | §13.1, §14.2 | 採用 | backup/upload回収基盤に使わずalarm/Cronへ移した。 |
| §1.1 D1 10GB/DB・account容量・全体予算 | §13.1–13.2, §14.3 | 採用 | 70/80/90% admission/alert/maintenanceを追加。 |
| §1.1 D1 queries 1,000/invocation | §12, §15.1 | 採用 | 一件ごとの認可を禁止し、集合query予算を固定した。 |
| §1.1 bind100はstatement単位 | §3.4, §15.1 | 採用 | SQL生成時countと99/100/101 fixtureを追加。 |
| §1.1 D1 batch全体も30秒 | §13.1, §15.2 | 採用 | query/batch全体の両方を正本化。 |
| §1.1 SQL100KB、row/string/blob2MB、100列 | §13.1, §3.1 | 採用 | 大manifest/indexはR2へ置く契約にした。 |
| §1.1 LIKE/GLOBはescape後50B、関数引数32 | §12.2, §13.1 | 採用 | fallbackのescape後上限を固定。 |
| §1.1 Time Travel30日・restore rate | §13.1, §11.3 | 採用 | logical backupとは別の補助手段にした。 |
| §1.1 bundle64MiB/startup1s/assets数・size | §13.1, §15.2 | 採用 | build/staging gateのplatform正本へ追加。 |
| §1.2 SQLite DO 10GB、2MB、bind/SQL上限 | §13.1, §14.2 | 採用 | DO別storage警戒値とrow上限を追加。 |
| §1.2 DO soft 1,000req/sは保証値でない | §13.1, §14.2, §15.2 | 採用 | 同一space/ControlDO負荷をstagingで測る。 |
| §1.2 DO CPU 30/300秒 | §13.1, §14.1 | 採用 | Workerと同じ設定・脚注へ統合。 |
| §1.2 blockConcurrencyWhile 30秒/reset | §2.1, §13.1, §14.2 | 採用（実測は後段） | constructor初期化だけに限定しstaging fault test対象。 |
| §1.2 alarm単一・at-least-once・2秒/6 retry | §13.1, §14.2 | 採用 | 最短deadline集約、枯渇後Cron repairを固定。 |
| §1.2 Queue 128KBはdecimal・metadata込み | §13.1–13.2 | 採用 | app messageを120,000Bへ縮小。 |
| §1.2 sendBatch 100件かつ256KB | §13.1–13.2 | 採用 | app上限100件/240,000Bを追加。 |
| §1.2 retention既定4日、最大14日 | §13.1, §14.1 | 採用 | `queues update`で14日を明示設定。 |
| §1.2 Queue CPU/wall、concurrency/retry/throughput | §13.1–13.2, §14.1 | 採用 | delivery retry10、app attempt3を分離。 |
| §1.2 Cron 250/account・UTC・CPU/wall | §13.1, §14.1–14.3 | 採用 | hourly/daily/weeklyの3式とjob固有budgetを維持。 |
| §1.2 R2 part≤10,000、5MiB–5GiB、最終part例外 | §6.1, §13.1–13.2 | 採用 | app非最終8MiB以上、最終0B可を明記。 |
| §1.2 R2 object/500GiB app上限 | §13.1–13.2 | 採用 | platform約5TiBとv1 500GiBを分離。 |
| §1.2 incomplete multipart既定7日との整合 | §6.2, §13.2, §14.2 | 採用 | app6日、alarm/Cron abortを固定。 |
| §1.2 same-key write 1/sと429 | §10.3, §13.1, §13.3 | 採用 | immutable keyと429 backoff/CASを追加。 |
| §1.2 R2 key1,024B/metadata8,192B | §13.1, §3.3 | 採用 | 論理pathをkeyにしない方針と接続。 |
| §1.2 Images入力20MBであり20MiBでない | §10.3, §13.1–13.2 | 採用 | 20,000,000Bへ修正。 |
| §1.2 Images dimensions/animation/AVIF plan | §10.3, §13.1, §18 | 採用（実測は後段） | dimension/frameを追加しAVIF未対応はunsupported。 |
| §1.2 KV key/metadata/value/write/cacheTtl | §13.1 | 採用 | 全値を一次資料付きで追加。 |
| §1.2 KV 1,000 callsと共通表の不整合 | §13.1, §18 | 採用（実測は後段） | 当面≤1,000で設計しstaging確認。 |
| §1.2 KV eventual consistency | §1, §4.1 | 採用 | 認可/失効/mutexへ使用しない。 |
| §1.3 JSON/XML parser budgetはparse中に必要 | §7.1, §13.2, §15.2 | 採用 | adapterでdepth/要素/属性/sizeを強制。 |
| §1.3 nameの「文字」定義とcasefold列 | §3.3, §13.2 | 採用 | Unicode scalarとcasefold列1,024Bを固定。 |
| §1.3 DAV If/Timeoutはapp制限 | §7, §13.2 | 採用 | protocol fixtureとbounded parserへ統合。 |
| §1.3 PROPFIND 32MiB/2,000はmemory/query懸念 | §12.1, §13.2, §15.1 | 採用 | v1 childrenを1,000へ縮小し集合query/preflightを定義。 |
| §1.3 upload call/byte budgetがcleanup枠を圧迫 | §6.2, §14.2 | 採用 | data callとcontrol/cleanupを別counterにした。 |
| §1.3 physical headroom・version保持の曖昧さ | §6.3, §13.2 | 採用 | quota遷移を固定し「10件または30日の長い方」に確定。 |
| §1.3 backup/GC/RPO/RTO不整合 | §11.3, §13.2, §18 | 採用（RTOは後段） | logical backupと月次drill、RTO実測を追加。 |
| §1.3 ticket更新/並列lease回収 | §8.2–8.3, §14.2 | 採用 | content-session更新と耐久lease期限回収。 |
| §1.3 ZIP size計上/pin | §8.3, §10.2 | 採用 | descriptor/CD含む計算と配信終了までpin。 |
| §1.3 archive index JSON/overflow | §9A.2, §10.2 | 採用 | safe integer/offset overflow/local-CD一致を追加。 |
| §1.3 Gallery rows/candidate | §12.3, §15.1, §18 | 採用（実測は後段） | rows_read fixture未合格時10,000へ縮小。 |
| §1.3 Audio coverとRange規則 | §9A.3, §13.2 | 採用 | metadata offset/lengthによる追加Rangeだけ許可。 |
| §1.3 WASM RGBA memory懸念 | §10.3, §13.2 | 不採用（WASM画像変換） | 128MB isolateで安全な作業領域を保証できずv1不採用。 |
| §1.3 node/userだけでD1全体を守れない | §13.2, §14.3 | 採用 | DB使用率admissionを追加。 |
| §1.3 search候補とscan、bulk manifest | §3.1, §12.2, §15.1 | 採用 | actual rows_readを測りmanifestはR2へ移した。 |
| §1.3 audit/operation/outbox retentionと容量 | §13.2, §14.3 | 採用 | 90日とDB閾値監視を接続。 |
| §1.3 JWKS single-flight/rate/cooldown | §4.1 | 採用 | issuer単位で固定。 |
| §1.3 Access/JWT/CSRF値はapp方針 | §4.1, §4.3–4.4 | 採用 | platform保証と分離した。 |
| §1.3 PBKDF2 600k受理・memory gate | §4.4, §15.2, §18 | 採用（600kは後段） | v1既定100k、scrypt不採用。 |

## 2. Binding API / Wrangler（レビュー §2）

| 指摘 (節番号 + 要旨) | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| §2 R2 create/resume/uploadPart/complete/abort意味論 | §1, §6.1–6.2 | 採用 | uploadId耐久化、resume非検証、etag保存、response loss照合を固定。 |
| §2 multipart completeにonlyIf無し | §6.2 | 採用 | R2条件をD1 revision CASの代替にしない。 |
| §2 R2 put onlyIf失敗はnull | §1, §13.3 | 採用 | exceptionだけで判定しない。 |
| §2 writeHttpMetadataは安全headerを作らない | §10.1, §10.4 | 採用 | WorkerがETag/Range/CSP/headerを構成。 |
| §2 D1 bindingはpositional bind | §1, §5.2 | 採用 | named placeholderを排除。 |
| §2 D1 batchはtransactionだがzero-row成功 | §5.2 | 採用 | 全statementの`meta.changes`検証を契約化。 |
| §2 first-primaryは最初だけ | §3.4 | 採用 | 権威queryはprimary bindingへ直接発行。 |
| §2 blockConcurrencyWhileは短時間だけ | §2.1, §14.2 | 採用 | 外部I/Oを囲まない。 |
| §2 DO SQLite APIはD1と別 | §2.1, §14.2 | 採用 | DO固有schema/restart試験へ分離。 |
| §2 DO alarmは一つ | §14.2 | 採用 | 最短deadlineへ集約。 |
| §2 Queue send/ack/retry semantics | §5.3, §13.1–13.2 | 採用 | durable受付とjob完了を分離し、D1確定後ack。 |
| §2 Images chain/output await/format | §1, §10.3 | 採用 | API順序とformat必須を固定。 |
| §2 Rate Limitingはlocal/eventual | §1, §13.1, §13.3 | 採用 | 一次防御だけ、厳密quota不可。 |
| §2 waitUntil/DO waitUntilの限界 | §13.1, §14.2 | 採用 | 耐久処理はalarm/Cron/outbox。 |
| §2 run_worker_first/ASSETS boundary | §2.2, §5.1, §14.1 | 採用 | unknown public routeをassetsへ渡さない。 |
| §2 scheduled handler併設 | §2.1, §14.1 | 採用 | fetch/queue/scheduled/DO exportを明記。 |
| §2 Wrangler例に必須binding/migration/consumer不足 | §2.3, §14.1 | 採用 | D1/R2/KV/DO migration/Queues/Images/ratelimit/envを全記載。 |
| §2 compatibility date後のNode既定挙動 | §14.1 | 採用 | 曖昧にせず`nodejs_compat`を明示固定。 |
| §2 resource ID/custom domain/CPU budget | §14.1 | 採用 | env別ID/routeとcpu_msを追加。 |

## 3. Streaming（レビュー §3）

| 指摘 (節番号 + 要旨) | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| §3.1 R2→Response stream/null/conditional body | §10.1 | 採用 | 404/304/body有無を分岐。 |
| §3.1 Range 206/416、HEAD、ETag | §10.1, §8.2 | 採用 | Worker構成、D1/R2 ETag分離。 |
| §3.1 multi-rangeとcontent encoding | §10.1 | 採用 | budget取得後200、identity配信。 |
| §3.2 uploadPartはknown lengthが必要 | §6.1 | 採用 | `FixedLengthStream(expectedBytes)`を必須化。 |
| §3.2 producer/consumer同時開始・停止伝播 | §6.1, §15.3 | 採用 | 先にpipe完了をawaitしない。 |
| §3.3 TransformStreamとFixedLengthStreamの区別 | §6.1, §16 Phase0 | 採用 | known-length再構成をPhase0で実証。 |
| §3.4 ZIP逐次R2、小並列、backpressure | §8.3, §10.2 | 採用 | bounded queue/drain契約。 |
| §3.4 fflate ondataはasyncをawaitしない | §10.2, §13.5 | 採用 | sync adapterで明示。 |
| §3.4 Promise.all/tee/disconnect禁止 | §10.2, §15.3 | 採用 | cancelとlease解放をfixture化。 |
| §3.4 CRC/descriptor/size/pin | §8.3, §10.2 | 採用 | 全bytes計上、配信終了までpin。 |
| §3.5 archive local/CD整合・暗号化拒否 | §9A.2, §10.2 | 採用 | flags/method/name/sizeを照合。 |
| §3.5 ZIP64/safe integer/output/CRC | §10.2, §13.2 | 採用 | v1 download非ZIP64、展開overflow/CRCを検査。 |
| §3.5 stream後CRCはstatus変更不能 | §10.2 | 採用 | stream error契約へ修正。 |

## 4. D1 schema / query / backup（レビュー §4）

| 指摘 (節番号 + 要旨) | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| §4.1 trash_ops DDL欠落 | §3.1 | 採用 | state CHECK付き実DDLを追加。 |
| §4.1 root以外parent NULL/別space parent | §3.1 | 採用 | CHECKとparent triggerを追加。 |
| §4.1 TEXT PK NULL | §3.1, §5.2, §11.2 | 採用 | 全TEXT PKをNOT NULL + STRICT。 |
| §4.1 deleted children index不足 | §3.1 | 採用 | non-partial `nodes_children_deleted`追加。 |
| §4.1 owner/blob/quota/root/operation/media制約 | §3.1–3.4, §5.2, §11 | 採用 | migration deliverableとproof SQLへ固定。 |
| §4.2 FK既定有効/defer_foreign_keys | §3.1, §16 | 採用 | FK回避をせずmigration rehearsalで検証。 |
| §4.2 generated column/Unicode normalization | §3.3, §12 | 採用 | normalizationをapplication/version固定。 |
| §4.2 FTS rowid/sync/rebuild/bigram | §11.3, §12.2 | 採用 | stable integer rowid、app bigram、実rebuild SQL。 |
| §4.2 RETURNINGはbuffer/副作用件数でない | §5.2 | 採用 | `meta.changes`期待値をstatement単位で検査。 |
| §4.3 bind100超のIN/VALUES/PROPPATCH | §3.4, §15.1 | 採用 | formula/chunk/JSON fixtureを追加。 |
| §4.3 atomic mutationをbind対策で分割不可 | §3.4 | 採用 | 明記。 |
| §4.4 return rows≠rows_read | §12, §15.1 | 採用 | 実SQL・index・M予算に置換。 |
| §4.4 PROPFIND一件ずつ認可/DO照会禁止 | §12.1 | 採用 | parent証明+集合join+DO一括照会。 |
| §4.4 Gallery/search大量scan | §12.2–12.3, §15.1 | 採用（実測は後段） | scope/subtree集合化、未合格なら候補縮小。 |
| §4.4 FK参照側index | §3.1 | 採用 | media/user stateの参照indexをmigration条件化。 |
| §4.4 D1単一thread bottleneck | §1, §13.1, §15.1 | 採用 | query duration/rows予算をrelease gate化。 |
| §4.5 exportはFTS virtual table未対応 | §11.3 | 採用 | normal tableだけlogical backup、FTS再構築。 |
| §4.5 export中block / dump alpha限定 | §11.3 | 採用 | Worker `dump()`に依存せずbounded logical scan。 |
| §4.5 journal/watermark整合点 | §3.1, §11.3 | 採用 | `backup_barrier`、journal、checksum/publicationを固定。 |

## 5. Durable Objects（レビュー §5）

| 指摘 (節番号 + 要旨) | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| §5.1 LockDO throughput/3往復/critical section | §14.2, §15.2 | 採用（実測は後段） | open permit64と同一space負荷test。 |
| §5.1 PROPFINDをcommit queue/一件RPCに入れない | §12.1 | 採用 | 集合lock照会を一回。 |
| §5.1 tree generation無関係folder競合 | §3.2 | 採用 | bounded retry3、枯渇409。 |
| §5.1 DO storage/part row/ControlDO/TicketDO/KDF | §6.2, §8.2, §14.2 | 採用 | DO別cap、耐久lease、KDF1/instance。 |
| §5.2 blockConcurrencyWhile長時間利用禁止 | §2.1, §14.2 | 採用 | constructor短時間だけ。 |
| §5.2 in-flightはSQLite永続化 | §6.2, §14.2 | 採用 | memory counterを禁止。 |
| §5.2 same part retry race | §6.2 | 採用 | 同part排他、attempt lease、last successful etag。 |
| §5.3 eviction後は永続state再構成 | §6.2, §14.2 | 採用 | Lock/Upload/Control別に規定。 |
| §5.3 alarm最短期限/request expiry/Cron repair | §14.2 | 採用 | 6 retry枯渇後も収束。 |
| §5.3 LockDO永久stale問題 | §7.3, §14.2 | 採用 | maintenance下でD1照合しnew epoch再初期化。 |

## 6. CI / staging（レビュー §6）

| 指摘 (節番号 + 要旨) | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| §6 localで可能/保証不可を区別 | §15.2 | 採用 | Access/HTTP/D1/R2/DO/Queue/Images/rate/Cron/browserを表化。 |
| §6 unit→Workers integration→staging | §15.2 | 採用 | 指定三段階と`wrangler deploy --env staging`を固定。 |
| §6 Images local一部可、Queue concurrency不可 | §15.2 | 採用 | Miniflare非保証表へ反映。 |
| §6 KDF/Rate/space負荷/query/alarm枯渇 | §14.2, §15.1–15.3 | 採用 | staging smoke/failure gateへ追加。 |
| §6 release前実client/canary | §15.2–15.3 | 採用 | Finder/Explorer/rclone/browser/log canaryを追加。 |

## 7. 実装契約（レビュー §7.1〜7.6）

| 指摘 (節番号 + 要旨) | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| §7.1-A final barrier実SQL不足 | §5.2 | 採用 | final `UPDATE operations ... state='claimed' AND epoch AND step count`を掲載。 |
| §7.1-A zero-row時SQL error triggerでrollbackすべき | §5.2 | **不採用（確定方針優先）** | 改訂依頼がfinal UPDATE + 全`meta.changes`検証 + 別batch failed補償を明示指定したため。zero-rowは論理失敗として扱う。 |
| §7.1-B batch後例外とrollbackを混同 | §5.2 | 採用 | rejectionとresponse lossを分離し、committedをfailedへ戻さない。 |
| §7.1-C claimOperation/insertClaim二重性 | §5.2 | 採用 | claimを単独INSERT/ON CONFLICT一回に固定。 |
| §7.1-C abandoned claim回収 | §5.2–5.3, §15.3 | 採用 | 同digest再送/repairでterminalへ収束。 |
| §7.1-D LockDO-D1は分散transactionでない | §5.2, §7.3 | 採用（代替） | permitをoperationへ記録し、expiry時D1 terminal照合前に解放しない。 |
| §7.1-D proofへpermit一致を入れる案 | §5.2 | 不採用（確定方針優先） | 確定方針がproof条件へpermit一致を含めず、D1照合付き期限回収を指定。 |
| §7.1-E MOVE lock終了の可視性 | §5.2, §7.3 | 採用 | commit後`release(permit_id,result)`、失敗は期限回収。 |
| §7.1-F quiesce完了条件 | §5.2, §11.3 | 採用 | open permit=0 + expired permit全D1照合済みに固定。 |
| §7.2 app_admin support policy曖昧 | §4.2 | 採用 | v1は他者content read禁止。 |
| §7.2 grant/scope enum曖昧 | §4.2 | 採用 | scope enumを列挙。 |
| §7.2 create/write/MOVE/delete operand不足 | §4.2, §5.1 | 採用 | operation tupleとroute operandsを具体化。 |
| §7.2 generic Operand[]では欠落防止不能 | §4.2 | 採用 | discriminated tupleを正本化。 |
| §7.2 terminal replay field/purge/再発行 | §4.2 | 採用 | 開示fieldを限定し再発行credentialはreplay不可。 |
| §7.2 saved principal/system principal | §4.1–4.2, §5.3 | 採用 | current grant再検査とsystem operation列挙。 |
| §7.2 route表の`...`/public-share曖昧 | §5.1 | 採用 | 一method-template一operationの完全manifestへ展開。 |
| §7.2 binary partのOrigin/CSRF規則 | §5.1 | 採用 | JSON mutationと分離。 |
| §7.2 internal share restore後復活 | §3.2, §8.1 | 採用 | 同期失効、restore非復活。 |
| §7.3 UploadDO stale state不統一 | §6.2 | 採用 | 別stateを増やさず`failed(reason=stale_epoch)`に統一。 |
| §7.3 initiating副作用順/orphan/quota | §6.2 | 採用 | `created`遷移表に順序・冪等鍵・回収を記載。 |
| §7.3 completing中間/課金/照合 | §6.2–6.3 | 採用 | attempts/r2_etag/headと同batch charge。 |
| §7.3 abort/expire cleanup | §6.2 | 採用 | terminalとcleanup_pendingを分離。 |
| §7.3 same part late overwrite | §6.2 | 採用 | 排他lease、attempt ID、last successful etag。 |
| §7.3 trash `removed`不一致 | §3.1, §11.1 | 採用 | pending/trashed/restoring/restored/purging/purgedだけ。 |
| §7.3 restore root公開時点 | §11.1 | 採用 | descendant/失効完了後の最終batch。 |
| §7.3 purge safe root未定義 | §11.1 | 採用 | staging parentを作らずmanifest cursorで子→親削除。 |
| §7.3 GC複数pin | §11.2 | 採用 | `blob_pins`を権威、`pinned_by`をmaterialized fence。 |
| §7.3 outbox consumer先行/lease | §5.3 | 採用 | completedをsentへ戻さずlease expiryで再送。 |
| §7.3 derivative旧worker publish | §5.3, §10.3 | 採用 | claim token/fence CAS。 |
| §7.3 job lease response loss | §5.3 | 採用 | checkpoint/fence/副作用を同batch。 |
| §7.3 R2 ListPartsを期待できない | §6.2 | 採用 | DO rowと同part再送だけで回復。 |
| §7.4 XML fixture不足 | §7.2 | 採用 | PROPFIND/propstat/PROPPATCH/LOCK/UNLOCK/423/depth/COPY-MOVEを各30行以下で追加。 |
| §7.4 namespace URI+localName | §7.1 | 採用 | prefix文字列解釈を禁止。 |
| §7.4 fast-xml-parser設定/DTD/entity/budget | §7.1, §13.5 | 採用 | `davXml.ts`設定と標準5 entity手動decode。 |
| §7.4 Class 2 creator一致 | §7.3, §15.3 | 採用 | 同user別app passwordは一致、serviceは別principal。 |
| §7.4 旧token委譲規則 | §7.3 | 不採用 | RFC 4918 §6.4と両立しないため撤回。 |
| §7.4 large DAV COPY/MOVEのjob fallback | §7.3 | 不採用 | 確定方針により403 `too-large-for-dav`、自動fallback無し。 |
| §7.5 ticket搬送未確定 | §8.2 | 採用 | short-lived `__Host-ncf_cs` Cookieへ確定。 |
| §7.5 全体blob URL案 | §8.2 | 不採用 | 大容量mediaでmemory/URL lifecycleが成立しないため≤32MiB text/Markdown/pdf.jsだけ。 |
| §7.5 EPUB shellとscript禁止矛盾 | §9A.2, §10.4 | 採用 | trusted shell + script無しpublicationの二重iframe。 |
| §7.5 publication sanitize/CSP/font | §9A.2 | 採用 | server Queue sanitize derivativeとinner CSPを固定。 |
| §7.5 anonymous share assets | §5.1, §9 | 採用 | public bundle/SRI/manifest auth public。 |
| §7.6 10 phaseが粗い | §16 | 採用 | 30 deliverableへ細分化。 |
| §7.6 dependency順/outbox/LockDO前倒し | §16 | 採用 | Phase0/Foundation依存を明記。 |
| §7.6 Foundation gate循環 | §16 | 採用 | 当該不変条件+既存回帰だけを完了条件に修正。 |

## 8. 依存ライブラリ（レビュー §8）

| 指摘 (節番号 + 要旨) | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| §8 Honoは可、upload body parser禁止 | §13.5 | 採用 | binary routeでparser middlewareを通さない。 |
| §8 `@hono/zod-openapi`採用/版固定 | §13.5 | 採用 | exact package/version、別packageとの混同禁止。 |
| §8 fast-xml-parser設定不足 | §7.1, §13.5 | 採用 | adapter外direct import禁止。 |
| §8 fflate sync stream可 | §10.2, §13.5 | 採用 | `Zip/ZipPassThrough/ZipDeflate`だけ。 |
| §8 fflate Async API | §10.2, §13.5 | 不採用 | Web/Node Worker依存がWorkers契約と合わない。 |
| §8 hash-wasm runtime compile | §6.1, §13.5 | 不採用 | `WebAssembly.compile()`依存を避けDigestStreamを採用。 |
| §8 multipart全体hashの意味 | §6.1 | 採用 | per-part digestと`client_sha256`を分離、verifiedはsingleだけ。 |
| §8 pdf.js browser利用 | §13.5, §10.4 | 採用 | server DOM/Canvas禁止、worker/CMap/CSPをbundle。 |
| §8 React/Vite等はbrowser/buildのみ | §9, §13.5 | 採用 | Worker SSRを導入しない。 |
| §8 PBKDF2 600k本番受理不明 | §4.4, §15.2, §18 | 採用（後段） | 100k既定、600k受理をstaging最初のgate。 |
| §8 scrypt 32MiB級memory | §4.4, §18 | 不採用 | isolate memory上限を保証できない。 |
| §8 dependency用途/制約/禁止API表 | §13.5 | 採用 | exact version/lockfile方針と表を追加。 |

## 9. 必須修正 P0/P1（レビュー §9）

| 指摘 (節番号 + 要旨) | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| P0 complete migration/proof/barrier SQL | §3.1, §5.2, §16 | 採用 | core DDL/実SQL/Phase0 D1 loss fixture。zero-rowは確定方針どおり論理失敗。 |
| P0 commit不明/補償/LockDO fencing | §5.2, §7.3, §15.3 | 採用 | rejection/loss分離、permit D1照合、quiesce。 |
| P0 UploadDO副作用付き遷移 | §6.2–6.3 | 採用 | 完全遷移表、head照合、課金同batch。 |
| P0 trash/restore/GC境界 | §11.1–11.2 | 採用 | state統一、公開点/pin/不可逆点SQL。 |
| P0 CONTENT_HOST/EPUB | §8.2, §9A.2, §15.3 | 採用 | Cookie搬送、二重iframe、browser gate。 |
| P0 WebDAV Class 2 | §7.3 | 採用 | creator一致へR4再変更。 |
| P0 KDF/WASM/fflate | §4.4, §6.1, §10.2, §13.5 | 採用 | 100k/DigestStream/sync fflate、scrypt/hash-wasm不採用。 |
| P0 FTS backup/restore | §11.3, §14.3 | 採用 | normal table export、FTS実SQL、epoch+1、月次drill。 |
| P1 Queue/Images/固有限界/error mapping | §13.1–13.3 | 採用 | 一次資料URL付き正本とmapping表。 |
| P1 一覧/search/PROPFIND SQL/index/budget | §3.1, §12, §15.1 | 採用 | 実SQL/index、N/bind/M/T fixture。 |
| P1 DO容量/throughput/alarm/stale | §14.2, §15.2 | 採用 | in-flight、retry枯渇、restart/leak試験。 |
| P1 complete route manifest/XML例 | §5.1, §7.2 | 採用 | 全surfaceのauth/operation/operands/adminOnly、規範fixture。 |
| P1 phase分割/依存 | §16 | 採用 | 30 deliverable、M/U/I/R完了条件。 |

## 最終結果

v0.5はラウンド4の全指摘を、採用、理由付き不採用、または明示的staging gateとして処理した。Cloudflare公式数値のURLは `DESIGN.md` §13、実装前spikeと未確定値は§16 Phase 0 / §18を正本とする。
