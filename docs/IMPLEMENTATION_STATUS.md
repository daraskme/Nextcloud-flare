# 実装進捗

更新: 2026-09-23。設計 v0.6 + IMPLEMENTATION_BRIEF §8 を実装契約とする。
セッションの再開手順は [`HANDOFF.md`](HANDOFF.md)。本書を実装状況・テスト件数の正本とする。

## 今回の実装

| 項目 | 成果物 / 実証内容 | 状態 |
|---|---|---|
| 0.1 toolchain | Node/pnpm/TS/Wrangler/Vitest/fflate を exact 固定、pnpm lockfile、公開日証拠 `toolchain.json`、CI | ローカル実装済み |
| 0.1 binding | 全 Env binding、SQLite DO の eviction 後の永続化、未実装 route は fail closed、未処理 Queue は retry | ローカル実装済み |
| 0.1 KDF/Images | PBKDF2-SHA256 100,000/16B/32B を OpenSSL の vector と照合。PNG→WebP。20,000,000B/寸法/40MP のアプリ入力境界 | ローカル実装済み、実サービス gate は未完了 |
| 0.2 D1 barrier | `changes()` の直前 statement 性、CHECK rollback、G01 node/tree/trash、全8必須 step の zero-row 注入、前後 EXISTS fallback | workerd D1 で実証 |
| 0.2 outcome | 例外の分類、commit 後の応答喪失を注入して primary で terminal を照合、最大3回/5秒、未確定503 | ローカル実装済み |
| R6 #2 の probe | expired-open/revoked/released/wrong-space permit、old epoch、失効/期限切れ session、disabled actor | 最小 fixture で実証。全 principal 認可は Phase 1 |
| 0.3 streams | FixedLengthStream + DigestStream を直列供給。0B/3B/95,000,000B、長短 mismatch、R2 条件不成立、slow consumer/cancel | ローカル実装済み |
| 0.3 Range | R2 部分取得、HTTP probe の206/416/HEAD/304、suffix/open-ended/多重 Range の正規化 | ローカル実装済み |
| 2 immutable blob read 基盤 | current `node.read` assertion と node/blob/物理観測行を同一 D1 batch で照合し、R2 key の owner/blob 束縛、object のサイズ/ETag、D1 content ETag、HEAD/206/304/416、If-Range、MIME/Disposition、no-store/nosniff を内部 helper で処理 | 実 D1/R2 binding と失効競合で検証。purpose、content session、BudgetDO、公開 route は未接続 |
| 6 content blob read 基盤 | 署名 ticket の D1 現行検査→発行元 ticket 束縛 content session→署名 Cookie→node/blob/R2 manifest と current credential を同一 D1 batch で検証。内部共有は選択した share root と対象ノードの祖先関係を同じ batch で確認 | private/匿名 share の実 D1/R2、共有外への移動、失効・share version・hash 競合、復旧監査で検証。content/GET/HEAD 以外の経路は未接続 |
| 6 BudgetDO 基盤 | `budget_id` の SQLite 永続 counter、target bytes×3、1024 requests/10分、8並列、10分 lease/alarm、unknown 全額消費。配信 GET/Range/HEAD/304 の reserve/settle を内部ストリームに接続。D1 trigger で owner あたり active budget 64件を制限 | eviction、上限、失効後の再初期化、実 R2 配信と64/65件境界を workerd で検証。budget 発行・全 route 接続は未完了 |
| 6 budget 確保基盤 | `u:<user>`、`u:<user>:s:<share>`、`s:<share>:c:<unlock>` の ID を D1 で再利用。node/owner、選択 share root、現行 credential、expiry、maintenance を同一 batch で検査し、revoke は再有効化しない | private・app password・内部共有・匿名共有、別 tab 相当の再確保、共有外への移動、失効と停止、最大長 ID の ticket 署名を workerd で検証。target set/ticket の内部発行サービスは実装済み。HTTP 発行 route は未接続 |
| 6 target set/ticket 発行基盤 | 最大1,000件の target を決定的 JSON と SHA-256 で R2 に staging・読戻し検証し、全 node/blob/share の現行認可、budget、ticket と target set を D1 batch で確定。応答喪失後は D1 を再照合し、未確定 object を削除 | private・内部共有・匿名リンク、複数 target、credential 失効競合、D1 応答喪失を workerd で検証。HTTP 発行 route は未接続 |
| 6 ticket 取り消し基盤 | current credential を確認し、ticket と派生 content session を同じ D1 batch で失効。budget は他 ticket と共有するため維持 | 再実行、Cookie と redemption の失効、別 credential・失効 session の拒否、D1 応答喪失後の照合を workerd で検証。HTTP 取り消し route は未接続 |
| 6 private ticket HTTP handler | app host の Access JWT→D1 session→CSRF 発行→同一 origin・bounded JSON の ticket 発行/取消を Worker entry に接続。ticket 期限は Access session 期限以内 | RS256 JWT、実 D1/R2、CSRF、session 登録から取消、JWT 欠落と設定欠落の拒否を workerd で検証。ControlDO は maintenance 固定で公開停止、remote issuer/AUD/署名鍵/bootstrap 設定は未完了 |
| 1 private account HTTP | `/api/v1/me` は current credential/user/space/quota を照合、logout は CSRF 後に D1 session と派生 content session を失効して Access logout に 303 | RS256 JWT、CSRF 欠落拒否、logout 後の再入場拒否を workerd で検証。ブラウザーの state 削除と navigation は Files UI 未実装 |
| 2 Files read HTTP | app の node 詳細と children 一覧を `node.read` 祖先証明＋maintenance の D1 batch に接続。keyset 最大200件、専用 HMAC cursor は parent/credential/epoch/tree generation/最終 sort key/期限を束縛 | 実 D1 で201件を2ページ、改変・期限切れ・tree 変更・他 user・maintenance を拒否。remote cursor ring と Files UI は未設定・未実装 |
| 2 folder create HTTP | `POST /api/v1/nodes` の bounded JSON、CSRF、Idempotency-Key を LockDO/permit/D1 の folder mutation に接続。`GET /api/v1/operations/:id` は同 credential の current operand/result を照合 | 実 LockDO/D1 の作成・再送・照会、CSRF 欠落、異 payload の409を workerd で検証。test-only admission であり実 ControlDO 再開は未実装 |
| 6 content HTTP 基盤 | content host の `/session` POST/OPTIONS と `/c/:nodeId/:blobId` GET/HEAD を ticket/Cookie、現行 D1 認可、BudgetDO、R2 に接続。exact Origin CORS、署名鍵と ControlDO/D1 admission の gate | handler で Cookie 発行から実 R2 配信を workerd 検証。ControlDO は maintenance 固定で実公開は停止、署名鍵・remote host inventory 未設定。page/entry/track/ZIP と全 route 会計は未完了 |
| 0.3 ZIP | 同一 fflate STORE serializer の metadata dry-run、CRC vector、Unicode、0/1,000 entries、ZIP32 上限、bounded queue、cancel | ローカル実装済み |
| 1.1 契約・schema | 53通常テーブル + FTS、147経路、scope/operation catalogue、FK index/削除順の生成、tree/terminal/session/accounting guards | migration と基盤契約を追加。全機能の状態遷移・認可は未完了 |
| 1.1 primary adapter | Sessions API を避け、全 authority query を直接 D1 binding へ発行 | 修正・回帰確認済み |
| R6 #4 epoch | SQLite pending→R2 history→D1 mirror→公開、eviction/storage loss、例外後の照合、単一 ControlDO | ローカル実装済み。admission/復旧 verifier/再開は未完了 |
| 1 ControlDO quiesce | 停止側 DO status→D1 maintenance/GC pause→permit revoke/claimed failed を atomic に収束。D1 応答喪失時の postcondition 照合、active job lease 診断、SQL 障害 rollback | 内部 RPC 実装。admission/復旧 verifier/再開と実 GC lease drain は未完了 |
| 1 復旧監査ページ | D1 quiesce、bootstrap/admin/root、owner ledger/ref、R2 HEAD size/etag と list 全件の D1 blob/derivative/archive 照合、outbox provenance/lease、share 予約量・root・version、credential の参照先種別・有効 scope root と4種の参照元 registry 行を各最大20件ずつ検証。FTS5 `integrity-check` (`rank=1`) と予約・未完了 upload・旧 outbox 等の最終 D1 fence を追加。完了後の再照会でも最終 fence を再確認し、失敗時は監査を先頭に戻す。停止中の FTS `rebuild`、旧 epoch の upload に紐づかない予約の bounded release と、旧 epoch `node.created` / `node.renamed` の bounded failed 収束は監査を初期化。ControlDO SQLite の epoch/token/R2 cursor 永続化、eviction・失敗ページ再試行・旧 epoch 拒否を実証 | 診断・限定修復。credential/share/outbox の全意味検証、他 event kind の cleanup、未知 R2 object の repair、incomplete multipart、Upload/GC/Queue drain と再開 gate は未完了 |
| R6 #3 session | fingerprint 一意登録、logout tombstone、同 user の content session 失効、job chunk の current-credential assertion | JWT verifier/内部 login に接続済み。HTTP 経路は未接続 |
| R6 #5/#6 schema | revoked scope detach、削除中 blob 復帰禁止、single upload 全49遷移の検証 | DB 制約を実証。purge/upload の実サービスは未実装 |
| 1 auth/JWKS | jose exact、固定 issuer/AUD、user/service 分離、KV1h・既知 stale24h、single-flight/rate/鍵数/size/timeout 上限 | Node/workerd 検証済み。rate は isolate 単位、実 Access/MFA policy gate は未完了 |
| 1 bootstrap | allowlist、初回 admin/space/root の atomic CAS、競合/rollback/応答喪失、暗黙 signup 禁止 | ローカル D1 で実証 |
| 1 node authorize | EffectiveLive、4 principal の scope/root/grant/current credential、commit 時 revision/tree/epoch/parent assertion。rename は root と share/scope root を拒否し、edit/node:write を要求 | read/create/rename/automation 5 operation の内部基盤。残る operation の認可は未完了 |
| R6 #7 CSRF | session 束縛 HMAC、TTL1h、再利用・再発行、purpose/aud/epoch/credential、current session/share、Origin 境界 | 内部サービスと D1 テスト実装済み。HTTP profile 接続待ち |
| 1 quota/ref/pin | owner/share reservation、unique logical、R2 HEAD physical、ref≤1,000、pin-only除外、各再送の一度だけ計上 | migration/内部サービス実装済み。GC/repair/namespace mutation 接続待ち |
| 1 D1 permit | space ごとの open 一意、identity固定、期限 revoke+claim failed+次 grant の atomic batch、応答喪失、old commit 拒否 | D1 primitive 実証。create/rename 用 LockDO へ接続済み |
| 1 LockDO | create/rename 認可と ancestor/対象/親 lock、intent 永続化、eviction/storage loss、新 epoch recovery、同 user 別 credential の token 検査 | ローカル実装。ControlDO admission 成功側は test fixture、実再開 gate 待ち |
| 1 operation claim | bounded canonical intent、同一 credential/key、claim 競合/応答喪失/current auth、lookup の情報制限 | create/rename 用内部サービス実装。公開 HTTP は未接続 |
| AVIF/AV1/Opus 追加要件 | bounded container sniff、実 codec の MIME、native 再生可否 probe、AVIF 原本 fallback | 単体20件。track parser/content/UI 接続は後続 phase、詳細 `MEDIA_FORMATS.md` |
| 1 fsMutation/create | node/parent/tree/search base/FTS/activity/outbox/terminal を一括確定。全必須 step の0行 rollback、並行再送、commit 応答喪失 | 内部サービス実装。公開 HTTP/実 ControlDO admission は未接続 |
| 1 rename mutation | 対象と親の lock/認可/permit、node/parent/tree revision、FTS の旧語削除と新語追加、activity/outbox/terminal を D1 batch で確定。実 LockDO 経由の実行、同一キー再送、異なる意図の衝突、失効後の拒否、衝突時 rollback を検証 | 内部サービス実装。公開 HTTP/実 ControlDO admission は未接続 |
| 1 名前/検索索引 | NFC/portable/byte/scalar、固定 Unicode 17 full casefold、NFKC/かな統一/bigram、同名拒否 | folder create の保存・初期 FTS に接続。検索 API は未実装 |
| 1 outbox producer | D1 lease→ID-only Queue send→sent、応答喪失/lease 回収/旧 sender/fast completed、bounded repair scan。Worker scheduled handler と毎分 Cron を設定し、ControlDO/D1 admission 後に最大50件を送る | ローカル接続済み。ControlDO が maintenance 中のため実送信は停止。実 Cron/Queue/DLQ 配信は未検証 |
| 1 outbox consumer 基盤 | `node.created` と `node.renamed` の current credential/権限、30秒 claim、元 operation step による由来確認、terminal CAS を D1 で検証。ID-only Queue の terminal ack と claim 中の再送抑止を追加。Worker Queue handler は ControlDO status と D1 mirror の一致を admission gate にして consumer に接続 | ControlDO が maintenance 中のため実 delivery は retry。実 Queue/DLQ、残る kind、再開は未完了 |

`packages/worker/test/fixtures/d1-schema.sql` は最小 probe schema であり、本番 migration ではない。
`src/db` と `src/platform` の基盤コードも公開 route には接続していない。
ControlDO は内部 RPC の epoch 発行・復旧を実装したが、maintenance / GC pause を解除しない。
LockDO は create/rename 用の内部 RPC を実装したが、実 ControlDO の admission は閉じている。UploadDO は拒否実装。BudgetDO の内部 RPC と content HTTP handler は動作するが、ControlDO admission が閉じ、署名鍵も未設定のため実公開は停止している。実装契約・残る境界は [`FOUNDATION.md`](FOUNDATION.md) を参照。

## Toolchain の判断

- 選定日 2026-09-21、公開日 cutoff 2026-09-14 00:00 UTC。直接依存の registry 証拠は `docs/toolchain.json`。
- jose 6.2.12 は2026-09-22に追加選定、公開日2026-09-05で既存 cutoff も満たす。Node/workerd の署名検証に使用。
- unicode-case-folding 1.1.1 は2026-09-22に追加選定、2025-10-01公開。Unicode 17.0.0 公式 C/F 表1,585件と全未割当 mapping の一致を確認。公開日・公式表の hash は `toolchain.json`。
- `pnpm-workspace.yaml` の `minimumReleaseAge: 10080` で推移依存にも7日の公開期間を要求。
- 使用する `@cloudflare/vitest-pool-workers@0.22.0` は Vitest 4 の `cloudflareTest` API。旧 `defineWorkersConfig` は使わない。
- pool 同梱 workerd が 2026-08-15 のため、compatibility_date を同日へ固定。設計の例示値 2026-09-21 を設定して黙って古い runtime に fallback させない。staging もこの値で検証し、更新時に gate を再実行する。
- Wrangler 自体は4.131.1、同梱 workerd は2026-09-11。staging でのランタイム差は未検証。
- pnpm 12 の `allowBuilds` を使用し、esbuild/workerd の install script だけを許可。
- 公式参照: [Workers tests](https://developers.cloudflare.com/workers/testing/vitest-integration/)、[FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/)、[DigestStream](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[R2 binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。依存の実際の API は固定した package の型定義とも照合した。

## 未完了の gate / 次の実装

1. 承認された staging inventory で全 binding/環境 marker/Access を照合し、実 D1 で同じ SQL barrier を再実行する。今回の「応答喪失」は commit 後の fault injection であり実ネットワーク断ではない。
2. Images 実サービスの20MB境界・codec・dimension、KDF CPU/cost、R2転送/キャンセルを計測する。ローカル Images は Miniflare 実装なので料金やサービス限界の証拠にしない。
3. Phase 1 残り: outbox の実 Queue ack/DLQ、他 kind の result CAS と repair、残る operation tuple の authorize/LockDO。ControlDO admission/再開と HTTP surface/CSRF の接続も必要。
4. R6 §8 の残りの fixture と仕様 v0.7 反映を Phase 1 内で閉じる。Files core/upload/trash/GC の本実装は Phase 1 gate 後。

## M/U/I/R と復旧

- **M**: `0001`〜`0008` を追加し、隔離 D1 と SQLite へ適用して FK/CHECK/trigger/FTS/会計/permit/operation/outbox identity を確認。リモート DB は未変更。probe schema は別 test file に隔離。
- **U**: Node の Range/Images 入力/長さ/commit分類・期限/SQLite テスト。
- **I**: Windows と NixOS のローカル workerd binding テスト。初回 CI の Windows 改行失敗を `.gitattributes` で修正し、[2fd68ac の CI](https://github.com/daraskme/Nextcloud-flare/actions/runs/35629022538) は Windows/Ubuntu 両方で成功（media 込み350 tests 時点）。今回の453 tests と前回の450/448/447/446/443/442/440/439/437/436/433/429/426/422/415 tests は以下のローカル実行記録。最新 HEAD の CI は GitHub Actions で照合する。
- **R**: 本番状態を変更していないため production rollback は N/A。依存更新の rollback は manifests/lockfile/toolchain記録を同じ版へ戻して frozen install。テスト R2 object は test 内の finally で削除する。
- 開発 state の破棄は dev 停止後に、このリポジトリ配下の `.wrangler/state` だけを対象として行う。実行前に絶対パスを確認する。staging/production の state や既存 bucket を削除しない。

## 実行記録

- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 303 = **502 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。`node.created` / `node.renamed` の outbox consumer と復旧監査で、通知 payload と保存済み operand/result の一致を確認。誤った結果を持つ event は完了せず、監査も拒否する。ControlDO は maintenance 固定で公開停止。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 301 = **500 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。app HTTP の node rename を既存サービスへ接続し、実 LockDO/D1 で CSRF、確定、再送、operation 照会、競合を検証。ControlDO は maintenance 固定で公開停止。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 300 = **499 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。folder 作成と operation 照会の app HTTP route を追加し、実 LockDO/D1 の作成・再送・競合を検証。ControlDO は maintenance 固定で公開停止。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 299 = **498 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。app の node 詳細・children 一覧を追加し、201件 keyset、署名 cursor と競合拒否を実 D1 で検証。ControlDO maintenance 固定と remote cursor ring 未設定で実公開は停止。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 298 = **497 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。app の `/me` と logout を追加し、current identity、CSRF、失効後の再入場拒否、Access logout 303 を検証。ControlDO は maintenance 固定で公開停止。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 298 = **497 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。app Worker entry に Access/CSRF/ticket 発行・取消を接続し、RS256 JWT と session 登録からの実 D1/R2、認証・設定欠落の拒否を検証。ControlDO maintenance 固定と remote 設定未完了のため実公開は停止。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 296 = **495 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。認証済み private content ticket HTTP handler を追加し、CSRF・同一 origin・bounded JSON、発行から取消まで実 D1/R2 で検証。Worker entry の Access 接続は未実装。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 295 = **494 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。ticket 取り消しと派生 content session の一括失効、budget 維持、別 credential・失効 session の拒否、D1 応答喪失後の照合を追加。HTTP 取り消し route は未接続。
- 2026-09-23、`pnpm check` 成功。Node 199 + workerd 292 = **491 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。target manifest の決定的符号化・R2 読戻し、最大1,000 target の認可証明一括処理、private/内部共有/匿名リンクの ticket 発行、D1 応答喪失と失効競合後の照合・R2 cleanup を追加。HTTP 発行 route は未接続。
- 2026-09-22、`pnpm check` 成功。Node 196 + workerd 285 = **481 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。private/内部共有/匿名 share の安定 ID で budget を D1 batch 確保し、同じ user の app password と Access が予算を共有すること、共有 root・maintenance・revoke・期限を検証。target set/ticket 発行は次の接続対象。
- 2026-09-22、`pnpm check` 成功。Node 196 + workerd 282 = **478 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。BudgetDO の旧有効期間終了後の再初期化と、内部共有 content read の選択 share root 祖先照合を追加。別権限で読める node を共有 root 外へ移した時の拒否を実 D1/R2 で検証。
- 2026-09-22、`pnpm check` 成功。Node 196 + workerd 281 = **477 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。migration `0010` で owner ごとの未期限切れ active budget を64件に制限。insert と再有効化の境界、revoke 後の再受付を SQLite と実 D1 binding で検証。budget 発行 API は未接続。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 280 = **475 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。content host の POST/OPTIONS ticket 交換と GET/HEAD blob 配信 handler を追加。Cookie→実 R2、CORS、blob ID 不一致、maintenance 中の発行拒否、Worker entry の鍵未設定 gate を検証。実 ControlDO admission とリモート署名鍵は未設定で公開停止。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 279 = **474 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。BudgetDO の SQLite 永続 lease と内部 blob 配信を接続。eviction、known/unknown 精算、8並列、0 byte を含む1024 request、同一ミリ秒の連続 request、alarm、失効 credential、GET/Range/HEAD/304 会計を workerd で検証。後続の修正で期限切れ lease 行の回収と窓更新後の再受付も検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 273 = **468 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。content ticket と Cookie の専用 HS256 kid ring、D1 ticket redemption、`content_sessions.ticket_id` migration、Cookie からの current blob plan を追加。private と匿名 share、cancel/version/rotation を workerd で検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 270 = **465 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。R2 target manifest の bounded hash 検証と node/blob/purpose/size 所属を `prepareContentBlobRead` に接続。D1 batch 直前の ticket/hash 変更を拒否。復旧監査の R2 list でも target manifest を検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 269 = **464 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。content session・ticket・target set・budget の D1 assertion を追加し、credential/purpose 不一致、target expiry、ticket/session 失効、budget revoke を検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 268 = **463 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。blob read plan の R2 key と owner/blob ID の一致を D1 内で検証し、誤った key を持つ初期行を workerd で拒否。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 267 = **462 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。`prepareNodeBlobRead` で current `node.read` assertion と node/blob/物理観測行を同一 D1 batch で照合。batch 直前のセッション失効と実 R2 配信を workerd で検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 266 = **461 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。内部 R2 配信 helper のサイズ/ETag 照合、D1 content ETag、HEAD/Range/If-Range、no-store と MIME/Disposition を実 binding で検証。認可/content session/BudgetDO と公開 route は未接続。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 265 = **460 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。有効な app password と service credential の scope root を space root まで再帰検証し、scope root 自体が残っていても祖先が trash の場合は復旧監査を拒否する。両種を個別に workerd で検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 264 = **459 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。復旧監査の共有 root を space root まで再帰検証し、共有 root 自体が残っていても祖先が trash の場合は拒否する。実 `trash_ops` と復元後の監査を workerd で検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 264 = **459 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。改名サービスの LockDO→D1→terminal 経路を workerd で検証。同一キー再送は副作用を重複させず、異なる意図とセッション失効を拒否する。
- 2026-09-22、復旧監査の outbox provenance に `node.created` / `node.renamed` と operation kind、step 1 node ID の対応検査を追加。偽装した kind と payload の拒否を D1 で検証。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 263 = **458 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。旧 epoch の `node.renamed` outbox を元の operation/node step の照合と claim drain 後に failed へ収束。改名操作に偽装した作成通知は残して最終 fence で拒否する。
- 2026-09-22、`pnpm check` 成功。Node 195 + workerd 263 = **458 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。rename の LockDO permit、operation claim、D1 一括 mutation、FTS の語句入れ替えと `node.renamed` consumer を追加。公開 HTTP と実 admission は未接続。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 258 = **453 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。最後に内部共有と service の rename ケースを追加し、対象32テストを再実行して成功。`node.rename` の current authority/親 operand assertion を追加。rename mutation/HTTP は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 255 = **450 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。旧 epoch `node.created` outbox を claim drain 後に bounded failed へ収束し、failed の再配信を ack する。実 Queue/DLQ と ControlDO 再開は未完了。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 253 = **448 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。最後に ControlDO 閉鎖時の Cron ケースを追加し、対象23テストも再実行して成功。scheduled handler と毎分 Cron を追加。実配信と ControlDO 再開は未完了。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 252 = **447 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。Queue handler の ControlDO/D1 admission gate を内部 consumer に接続。実 Queue delivery/DLQ と ControlDO 再開は未完了。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 251 = **446 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。最終 D1 fence と bounded stale reservation release を追加。ControlDO admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 251 = **446 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。完了済み監査の最終 D1 fence を再照会時に検証し、失敗した監査を初期化。ControlDO admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 248 = **443 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。credential registry の逆向き参照を4種の source に追加。ControlDO admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 247 = **442 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。R2 完成済み object の全件照合と永続 cursor を追加。ControlDO admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 245 = **440 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。FTS5 再構築・元テーブルとの整合性検証を追加。ControlDO admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 244 = **439 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。share/credential の復旧監査を追加。ControlDO admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 242 = **437 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。outbox の復旧監査を追加。ControlDO SQLite 監査進捗は診断専用であり、admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 241 = **436 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。ControlDO SQLite 監査進捗は診断専用であり、admission 再開は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 238 = **433 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。復旧監査は読み取り専用・ページ単位で、再開 gate は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 234 = **429 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。ControlDO admission/復旧 verifier は未実装。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。Node 195 + workerd 231 = **426 tests**、lint/typecheck/contracts/config と Wrangler dry-run build も成功。実 Queue 配信/DLQ は試験していない。
- 2026-09-22、NixOS / Node 24.20.0 / pnpm 12.3.4 で `pnpm check` 成功。配布済み workerd/Biome バイナリの ELF interpreter をローカル `node_modules` 内だけで調整。Node 195 + workerd 227 = **422 tests** 成功。lint/typecheck/contracts/config と Wrangler dry-run build も成功。リポジトリの固定版 Node 24.21.0 / pnpm 12.4.1 とは異なるため、CI で固定版の確認が必要。
- 2026-09-22、Windows / Node 24.21.0 / pnpm 12.4.1 で `pnpm check` 成功。
- Biome、TypeScript、contracts/config verifier: 成功。
- Node 単体: 9 files / 195 tests 成功。
- 前回の Windows ローカル Workers 統合: 18 files / 220 tests 成功（合計415 tests）。
- Vite build と Wrangler deploy **dry-run**: 成功。配備や remote migration は実行していない。
- Windows sandbox 内で esbuild の親 directory 読取りが拒否されたため、テストと dry-run build は承認された制限外プロセスで実行。Cloudflare の本番資格情報は使用していない。
