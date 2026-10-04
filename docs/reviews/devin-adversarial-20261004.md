# Devin レビュー・敵対的レビュー・検証（2026-10-04）

対象: `main` `9bcfb1c`。方法: `pnpm check` 全実行 + 7 領域の並列敵対的レビュー + 各指摘のコード検証（生の候補から誤検知を除外）。

## 検証結果

`pnpm check` 全段成功: lint 590 files、型検査（worker/web/fault-tsconfig）、契約・設定検査、Node 単体 998 件（8 skip）、統合 2,305 件 + 専用 R2 短尺 1 件（platform expected disconnects=2、未処理 Promise 0）、Web build + wrangler deploy dry-run 成功。

## 敵対的レビュー指摘（検証済み）

### HIGH

**H1. DAV PUT が検証済み暗号化 marker を持つファイルを平文で上書きできる**
`services/putFile.ts` の `overwriteStatements`（proof は permit/claim/authorization/locks のみ）に暗号化 guard がなく、`assertNoEncryptedSubtree`/`unencryptedSubtreeAssertion` を呼ぶ経路がない（`moveNode.ts:398-399,461,477`、`copyNode.ts:399-400,466,482`、`uploads/complete.ts:426` にはある）。`CLIENT_ENCRYPTION_REQUIRED=true` では DAV PUT 全体が入口で 403 だが、flag=false 環境で暗号化ファイルが存在する場合、app_password の PUT で `current_blob_id` が平文 blob に置き換わり、旧 ciphertext への marker が孤児化する。`ENCRYPTED_SUBTREE` CTE は `current_blob_id` を見るため当該 node は以後 rename/move/share/zip 可能になり、平文が R2 に残る。docs/CLIENT_ENCRYPTION.md の「サーバーは検証済み marker により UI 非依存で暗号化制限を強制する」契約違反。エージェントは vitest で実際に commit 成功を再現済み（一時テスト、削除済み）。

**H2. internal share の `download` action が app 経路で未強制**
`authorize.ts:477-485` の share action 対応は `create`/`edit`/`read` のみで `download` を出力しない。`contentTicket.ts:107`、`contentSession.ts:71`、`BudgetDO.ts:139` はいずれも `sa.action='read'` のみ検査。DAV 経路（`dav.ts:415` + `dav/path.ts`）だけが `download` を要求する。`read` だけの internal share の受領者が `POST /api/v1/content-session` を直接呼ぶとファイル本文全体（zip 経路含む）を取得できる。`test/integration/content-ticket.test.ts:873-912` が read-only share での ticket 発行を pin しており、INTERNAL_SHARES.md の「`download` がない file は ticket を要求しない」は browser 側のみの強制。

**H3. 共有 mount からの削除で trash_ops.actor_id が受領者になり、所有者から見えず復元も purge もできない**
`trashNode.ts:79` は `actor_id = authorized.principal.user_id`。internal share 経由の DAV DELETE（または overwrite を伴う MOVE/COPY: `moveNode.ts`、`copyNode.ts`）では principal は受領者の app_password で、owner の space に `trash_ops.actor_id=受領者` の行が確定する。`trashRead.ts` は `spaces.owner_id` 証明 + `t.actor_id=caller`、`restoreTrash.ts:63` は `t.actor_id=caller`、`purgeTrash.ts:60-64` は `s.owner_id=t.actor_id` を要求するため、owner は一覧にも出ず restore も purge もできない。`purge_after` を消費する sweeper は存在しないため恒久的に残り、quota を占有し続ける。受領者のみが（create 権限があれば）restore 可能。
併記: `authorize.ts:318` の非 bound user 句には `?6<>'node.trash'` があるが bound app_password 句（330-344）にはない。DAV 共有 mount の削除機能自体は「編集可能な shared DAV」の設計内だが、結果として bound 経路でのみこの状態に到達する。

**H4. owner_key=NULL の orphan tombstone が復旧 audit を恒久的に wedge する**
`orphanInventory.ts:121` は `^u/([^/]+)/b/([^/]+)$` に一致しないキーを owner_key=NULL で tombstone する（対象 prefix `u/` のみ走査、行254-255）。collector の due 条件（行387）は `owner_key IS NOT NULL` を要求し、`orphan_objects_delete_guard` trigger（migration 0021）が全 DELETE を拒否するため、この行は収集も削除もできない。recoveryAudit（`recoveryAudit.ts:861-898`）は `orphan_objects` の照合に `state='quarantined' AND owner_key IS NOT NULL` を要求するため NULL-owner tombstone は照合に失敗し `recovery_untracked_r2_object`、RECOVERY_FINAL_QUERY も `state<>'deleted' AND owner_key IS NULL` を拒否。epoch recovery は audit 完了後にのみ admission を再開するため、`u/{owner}/d/...` 派生キー（`media.ts` の put-before-mutate gap）や epub index キーのような未追跡オブジェクト 1 個で mutation admission が恒久的に再開不能になる。運用復旧経路は D1 手術のみ。

### MEDIUM

**M1. 共有 mount の DELETE/overwrite が owner の全 ticket・content_session を取消す**
`trashNode.ts:172-198` の `trash_tickets`/`trash_content_sessions` ステップは `target_set_id IN (SELECT id FROM target_sets WHERE owner_id=?)` で owner 全分を取消し、削除対象 subtree に限定されない（直上の share_sessions 取消しは trashed members 起点に絞られており対照的）。`moveNode.ts:189-214`、`copyNode.ts:207-228` も overwrite 時に同じ述語。受領者の subtree 削除権限が owner アカウント全体のアクティブ配信 session を破壊する副作用になる。

**M2. mutation admission queue に呼び出し元ごとの公平性がない**
256 waiting / 32 active の cap は `0030_mutation_admission.sql` trigger で table-wide に数えられ、space/principal 列がない。`mutationAdmission.ts` の enqueue 重複除去は permit_id のみで、固有 Idempotency-Key（または account mutation の random permit）で無限に新規 waiting を INSERT できる。`api/nodeMutations.ts` に EDGE_LIMITER 相当がなく、認証済み 1 ユーザーの持続的 flood が全 space と system=1 admission（GC、tree job）を `mutation_unavailable` にする。

**M3. Range 付き ZIP は全 archive をサーバー再生成し、budget は配信 byte のみ課金**
`zipDownload.ts:607-623` は `range.length` を reserve するが、`open()`（647-658）は各 blob を非 ranged `bucket.get` で全読みし、`sliceZip`（490-530）が offset 分を読み捨てる。`bytes=outputSize-1` の 1 byte Range で ~4 GiB の R2 read + 圧縮 CPU が 1 byte 課金で済み、lease window 内 `REQUEST_LIMIT=1024`・`PARALLEL_LIMIT=8` で継続可能。匿名の公開 link share 保持者も到達できる。`library.ts:271-284` の `readZipEntry` も全 entry を fetch/inflate してから range を切り出す（同型・規模は小）。

**M4. DLQ handler が live lease 保持中の tree job を fail させる**
`deadLetter.ts:227-240` は非 completed/failed な job に `failTreeJob(..., 'queue_exhausted')` を呼び、`failTreeJobInternal`（`treeJobWorker.ts:1006-1066`）は terminalGuard なしで `DELETE FROM job_leases` + state='failed' を無条件実行する。Queue retry 尽き後の DLQ 配信と dispatch lease 期限による再 dispatch で、実行中 worker が leaseAssertion で死亡し、大規模 trash/restore/purge が途中で恒久的に failed になる。兄弟経路 `failExhaustedTreeJob`（1106-1115）には `NOT EXISTS(active lease)` guard があり、意図との不一致が明確。

**M5. claim 済み未 settle の multipart_upload_settlements が epoch bump 後に解消不能**
`multipartClosure.ts:511-555` の `claimUpload` は `ON CONFLICT ... WHERE closure_id=excluded.closure_id` で同一 closure run でのみ reclaim 可能。worker が claim commit と settle commit の間で死亡し epoch が進むと、新しい proven run の claim は WHERE 不一致で永久に失敗し、reservation は 0046 trigger により settle なしでは解放不能。RECOVERY_FINAL_QUERY の `reservations state='reserved'` 句と scan-without-settled 句の両方を塞ぎ、復旧 fence が wedge する。

**M6. closure で settle された upload の gc_candidates が永遠に claim 不能（オブジェクト/課金リーク）**
`settleUpload`（multipartClosure.ts:601-631）は object 存在時に `cleanup_pending=1` + `gc_candidates 'candidate'` を挿入するが `multipart_cleanup_closed` を設定しない。`gc.ts:21-24` の `SETTLED_UPLOADS` は `mode='multipart' AND state<>'completed' AND multipart_cleanup_closed IS NULL` を除外するため当該 candidate は選ばれない。closed を書く唯一の経路 `multipartCleanup.ts`（repair 系、行207/233付近）は `NOT EXISTS(multipart_inventory_scans)` を要求し、全 claim 経路は `NOT EXISTS(gc_candidates)` を要求するため両方 dead end。R2 object は削除されず、physical_bytes 課金と cleanup_pending=1 が恒久的に残る（audit 上は 'queued' に見えるため無症状）。

### LOW / 既知

**L1. `GET /api/v1/nodes/:id/path` が share root より上の祖先名・id を返す**
`nodeRead.ts:80-123` は leaf の `node.read` のみ証明し、space root まで全祖先を返す。internal share 受領者は共有外の owner フォルダ名/id/revision を取得できる（web 側は `app.tsx:1439` 付近で share root 以降のみ表示するよう masking している）。INTERNAL_SHARES.md の mount 境界秘匿意図と不一致。サーバー側で share root で打ち切るべき。

**L2. share session pool の占有（既知・文書化済み）**
`shareSession.ts` の per-source 8 / 全体 64 cap に eviction がなく、8 程度の異なる source digest（異なる IP）で全 64 枠を占有でき、他 viewer の unlock が ≤7 日間 503 になる。ENVIRONMENT_STATUS.md に「分散 source による全体 64 枠の枯渇は残る」と既記録。

## 棄却した候補（誤検知メモ）

- `CLIENT_ENCRYPTION_REQUIRED` の commit 前再確認が DAV に無い件: 同値は env var で isolate 内不変のため mid-flight flip は成立せず、実害なし（文書の「policy change is checked again before file commit」の DAV 版としては過剰）。
- bound share 句の `node.trash` 非除外自体: 編集可能 shared DAV の設計内と判断。実害は actor_id（H3）側。
- エージェント側で falsified 済み: link-share/upload-only trash（CTE で拒否）、quiesce livelock、commit replay、GC fence→delete TOCTOU、reservation 二重解放、share cookie 再利用の password skip、EPUB sandbox / XSS sink、route manifest 不整合など多数。
