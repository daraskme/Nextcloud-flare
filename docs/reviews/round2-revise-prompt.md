あなたは Next-cloud-flare の設計担当です。`docs/DESIGN.md` (v0.2) に対する敵対的レビュー `docs/reviews/round2-astra.md`（GPT-6 Astra、判定: No）が届きました。

## 依頼: レビューを反映して `docs/DESIGN.md` を v0.3 に改訂する

- `docs/DESIGN.md` を直接編集（章立て 0〜18 は維持、必要なら節を追加）。先頭は `# Next-cloud-flare — 設計・実装方針 (v0.3)`、ステータス行に「Astra ラウンド1・2 反映済み」。
- レビューの **全指摘 (D-01〜D-11, A-01〜A-06, W-01〜W-05, C-01〜C-05, §5 状態機械の穴, §6 反映漏れ・自己矛盾, §8 必須修正 P0/P1)** を反映し、`docs/reviews/round2-resolution.md` に ID ごとの「反映章 / 採用・不採用・後段 / 一言」表を作成する。不採用は理由必須、後段は §18 に記載。
- 判断はレビューの修正案に従う。迷う場合は「安全側・v1 では制限」。以下は確定方針:

### 確定方針（ラウンド2）

1. **fsMutation を疑似コード（TypeScript 風）で確定**: `claimOperation(opId)` → 認可（全 operand: src/dst/parent/ancestors、upload/job/share/ticket ID の所有者結び付け）→ LockDO 検査（lock generation を取得）→ D1 `batch` で「操作 claim 行の INSERT (PK 衝突で冪等) + 期待 revision 条件付き UPDATE 群 + 親・祖先の `tree_generation` 検証/更新 + 従属更新」→ 影響行数を全 statement で検証し、1 つでも 0 なら操作全体を失敗扱い（batch は原子的なので rollback されるが、**条件付き UPDATE の影響行 0 は batch を失敗させないため、`RETURNING` または直後の SELECT で検証し、失敗時は補償として claim 行を `failed` に更新**）→ 成功後に outbox → 応答。LockDO 検査から D1 commit の間に新 LOCK が入る問題（W-03）は、commit に `lock_generation` を含め、LockDO は「commit 中の generation を予約 (`beginCommit(gen)`)」し、その間の新規 LOCK を 423/待機させる方式で解決する。
2. **循環 MOVE (D-02)**: space ごとに `spaces.tree_generation` を持ち、MOVE/COPY/DELETE/restore は `tree_generation` を期待値付きで +1 する（同一 space の構造変更を直列化）。祖先チェックは再帰 CTE で dst が src の子孫でないことを同 batch 内で再確認する（`INSERT ... SELECT ... WHERE NOT EXISTS(...)` 形）。
3. **complete の認可 (D-03)**: complete 時に再認可 + 親の存在/未削除/space 一致/tree_generation を同 batch で検証。
4. **trash 状態機械 (D-04, D-05)**: `trash_ops.state ∈ {deleting, trashed, restoring, purging, purged, failed}` を排他とし、restore は `state='trashed'` の条件付き UPDATE で `restoring` を claim（同時に旧 delete job は `state` 不一致で停止）。purge manifest は `purging` claim 後に再生成し、固定 manifest を使わない。FK 削除順序を明記: `user_node_state` → `node_props` → `shares`(CASCADE) → `node_versions` → `node_search` → `nodes`（子→親順、batch を分割し各 batch は `deleted_op_id=? AND state=purging` 条件）。
5. **GC と復旧 (D-06, D-08, D-09)**: `gc_candidates.state ∈ {candidate, pinned, deleting, deleted}`。R2 delete 直前に `deleting` を条件付き UPDATE で確定（不可逆点）、以降は復旧しても blob を復元しない。**GC 猶予期間 ≥ D1 バックアップ保持期間 + Time Travel 期間 (30 日)** に統一（猶予 = 35 日）。復旧制御は D1 の外: `ControlDO`（シングルトン）に `epoch` と `gc_paused` を保持し、全 job/lease/ticket/app password secret の HMAC 入力に `epoch` を含める。Time Travel 復旧手順では epoch を +1 し、旧 job/旧 ticket/旧 lease を無効化する。
6. **物理容量台帳 (D-07)**: `users.physical_bytes`（R2 に実在する全 blob 合計: 現行 + 旧世代 + 失敗 upload + gc 待ち）を導入し、quota 判定は `physical_bytes + reserved_bytes + new <= quota_bytes * 1.2`（論理 quota の 20% を GC 待ちの余裕）かつ `used_bytes + reserved_bytes + new <= quota_bytes`。失敗 upload の予約解放は blob が GC 完了するまで `physical_bytes` に残す。
7. **UploadDO (§5)**: 全失敗終端 (`failed`, `expired`, `aborted`) と理由列、in-flight part の barrier（`completing` 遷移時に進行中 uploadPart を待つ/拒否）、DO と D1 の照合優先順位（commit の真実は D1 の nodes.revision、DO は `committed` 記録と node_id/revision を保持し、不一致なら D1 を正として DO を修復）。
8. **認可の operand 全域化 (A-01〜A-03)**: `authorize` の入力を「principal × operation × operand 集合」とし、upload_id / job_id / share_id / ticket / idempotency key は「作成 principal または同 space の owner」にのみ束縛。download ticket は `node_id + blob_id + share_id + share_version` を含め、配信時に node が依然 share root の子孫であることを検証。unlock Cookie と ticket は別トークン種別（`typ` claim）で用途混同を禁止。
9. **upload-only (A-04)**: 衝突名は自動リネーム（`name (1)`）で常に 201 を返し、存在確認 oracle を作らない。
10. **Bypass フォールスルー (A-05)**: `routes.ts` の公開 prefix 配下は allowlist 完全一致、他は 404。private router は Access 認証 middleware 通過が型で強制される（`AuthedContext` 型なしでは handler 登録不可）。
11. **ticket / cache (A-06, C-03)**: ticket は単一 IP or 単一 UA に束縛せず（Range 並列を許す）、代わりに per-ticket の転送バイト上限（対象サイズ × 3）と有効期限（6h）で増幅を制限。共有 content の `Cache-Control` は `private, no-store` に変更（thumb のみ `private, max-age=300`）。
12. **WebDAV ロック (W-01〜W-04)**: lock は `node_id` を単位（正準リソース）とし URI は表示用、mount alias 経由でも同一 node の lock が効く。lock token の提示だけで足りる操作は RFC 通りだが、**UNLOCK と refresh は lock owner principal のみ** に制限（`lockdiscovery` の `owner` は表示情報のみ、token は他 principal に返さない = RFC 4918 §6.8 の許容範囲）。collection の getetag は `revision` に `node_id` を含めた `W/"<node_id>-<revision>"`（URI 再利用 ABA 対策）。
13. **ZIP (C-01)**: ZIP は R2 get の subrequest を消費するため、entry 上限 = 1,000（ページ分割案内）、合計 < 4 GiB、単体 < 4 GiB。ZIP64 は §18。1 ZIP = 1 ticket、ticket に entry manifest hash。
14. **D1 容量攻撃 (C-02)**: per-user のノード数上限（既定 200,000）、dead property 合計サイズ上限（node あたり 8 KB、user あたり 8 MB）、COW 参照数上限（blob あたり 1,000）。
15. **費用冪等 (C-04, C-05)**: part 再送は同 part 番号 3 回まで、セッションあたり uploadPart 呼出上限 = parts × 3、Images 変換は blob × variant × generatorVersion で 1 回のみ（結果テーブルで判定、失敗は 3 回で `failed` 固定）。
16. **client thumb (D-10)**: クライアント生成サムネイルは `node_id` 単位で保存（`u/<ownerId>/t/n/<nodeId>/<variant>-c.webp`）し、COW で共有される blob 単位サムネイルとは分離。write 権限のない principal は保存不可。
17. **文書矛盾 (§6)**: public multipart route、DAV 認証、quota 精算箇所などレビューが列挙した矛盾を全て解消し、数値は一箇所（§13 制限表）に集約して他章から参照する。
18. **状態機械表**: UploadDO / trash_ops / gc_candidates / job_leases / outbox / backup journal の各状態と遷移を「状態 → イベント → 次状態 → 副作用 → 失敗時」の表にする（§5 に集約）。

## 出力

- `docs/DESIGN.md` を上書き、`docs/reviews/round2-resolution.md` を作成。
- 標準出力には変更要約（10 行以内）のみ。
