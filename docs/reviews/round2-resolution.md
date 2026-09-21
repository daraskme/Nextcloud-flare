# Astra ラウンド2 指摘対応表

対象: `docs/DESIGN.md` v0.3

- ラウンド2の D-01〜D-11、A-01〜A-06、W-01〜W-05、C-01〜C-05、状態機械、ラウンド1反映照合、自己矛盾、P0/P1 を全件追跡する。
- 「採用」は v0.3 の実装契約へ反映済み。「後段」は v1 に安全な制限を置き、`DESIGN.md` §18 に明記したものを示す。
- 不採用はない。W-01 はラウンド2確定方針に従い、RFC の token semantics を維持しつつ token 非開示と UNLOCK / refresh の owner 制約を採用した。

## 1. データ破壊・不整合

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| D-01 | §3.4, §5.2, §15.2 | 採用 | 不変 blob、期待 revision、operation barrier により並行 PUT の敗者を全体 rollback する。 |
| D-02 | §3.2, §5.2, §15.2 | 採用 | space の `tree_generation` を構造変更ごとに CAS 更新し、再帰 CTE で循環・祖先を commit 内再検査する。 |
| D-03 | §4.1, §5.2, §6, §15.2 | 採用 | complete 時に全 operand、share / credential、親、祖先、space、tree generation を同 batch で再認可する。 |
| D-04 | §5.5, §11.1, §15.2 | 採用 | `deleting/trashed/restoring/purging/purged/failed` を排他化し、全 chunk を state と operation ID で guard する。 |
| D-05 | §3.1, §5.5, §11.1, §15.2 | 採用 | 循環 FK を除去し、upload / 別 trash 子を処理後、指定順・子→親で purge する。 |
| D-06 | §5.6, §11.3–11.4, §15.2 | 採用 | R2 delete 直前の `deleting` を不可逆点とし、新参照禁止、pin、ControlDO pause を定義した。 |
| D-07 | §3.1, §6.2, §11.3, §13.1 | 採用 | `physical_bytes` を導入し、失敗 upload と GC 待ちを物理削除まで容量に残す。 |
| D-08 | §11.3–11.4, §13.1 | 採用 | 30日 Time Travel と5日 D1 backup retention の合計以上に GC grace を置き、v1 は35日へ統一した。 |
| D-09 | §4.4, §11.4, §14.2, §15.2 | 採用 | D1 外の ControlDO epoch を更新し、旧 job / lease / ticket / app password / upload capability を無効化する。 |
| D-10 | §3.1, §10.3 | 採用 | client thumb を node key / node 権限へ分離し、COW の blob derivative を汚染しない。 |
| D-11 | §3.5, §5.2, §15.2 | 採用 | step proof と composite-FK / trigger barrier でゼロ行を SQL error 化し、失敗 claim を補償記録する。 |

## 2. 認可・capability・IDOR

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| A-01 | §4.1, §4.3, §5.2 | 採用 | `principal × operation × operand[]` とし、src / dst / parents / ancestors と全 non-node ID を主体・space に束縛する。 |
| A-02 | §5.3, §8.2 | 採用 | ticket に node / blob / share / version を含め、配信時に現在の share subtree 所属を primary で検査する。 |
| A-03 | §4.4, §8.1 | 採用 | unlock / download / ZIP / content-host / upload に別 `typ` と必須 claim を定義した。 |
| A-04 | §8.3, §9 | 採用 | upload-only は衝突時も自動 rename、常に同形 201 receipt とし、確定名・競合差を返さない。 |
| A-05 | §2.2, §14.3, §15.2 | 採用 | public allowlist 完全一致、未知 404、`AuthedContext` 型必須で private fallthrough を禁止する。 |
| A-06 | §8.2, §13.1 | 採用 | IP / UA binding はせず、TicketDO の TTL・byte・request・並列 budget と no-store で制御する。 |

## 3. WebDAV

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| W-01 | §7.3 | 採用 | token を他 principal の lockdiscovery に返さず、UNLOCK / refresh は creator 限定、mutation は RFC token semantics と write 認可を適用する。 |
| W-02 | §7.3 | 採用 | lock の正準 resource を `node_id` とし、owner path と shared mount alias を同一 lock に写像する。 |
| W-03 | §5.2, §7.3 | 採用 | `beginCommit(expectedGeneration)` 中は交差 LOCK を 423 / 待機にし、lock generation を D1 operation に保存する。 |
| W-04 | §7.3 | 採用 | collection validator を `W/"<node_id>-<revision>"` とし、URI 再利用 ABA を防ぐ。 |
| W-05 | §2.2, §4.1, §7.2–7.3, §13.1 | 採用 | If 式と token 提出を分離し、space / scope / Destination / XML / decode / timeout の各攻撃を明示した。 |

## 4. DoS・費用

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| C-01 | §5.3, §8.2, §13.1, §18 | 採用（ZIP64 は後段） | v1 は 1,000 entry、STORE、全 header 込み exact size、1 ticket / manifest hash とし ZIP64 は §18。 |
| C-02 | §7.2, §13.1 | 採用 | node、folder 幅、property 総量、COW refs、PROPFIND response を累積上限化し、超過時は開始前 507。 |
| C-03 | §8.2, §13.1 | 採用 | ticket ごとの size×3 bytes、TTL、request、並列と share / owner rate budget を TicketDO で厳密化する。 |
| C-04 | §5.4, §6.3, §13.1 | 採用 | part は番号ごと 3 attempts、session call は parts×3、累積 bytes / in-flight / wall deadline を制限する。 |
| C-05 | §5.8, §10.1–10.3, §13.1 | 採用 | server / client の unique result claim を重処理前に取り、3 failures で terminal `failed` にする。 |

## 5. 状態機械の穴

| ID | 対象 | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|---|
| SM-01 | UploadDO `initiating` | §5.4, §6.3 | 採用 | reservation / R2 ID の照合、deadline、`expired`、orphan repair を定義した。 |
| SM-02 | UploadDO `completing` failure | §5.4, §6.2 | 採用 | auth / CAS / checksum / R2 failure を reason 付き terminal `failed` とし、物理課金を GC へ移す。 |
| SM-03 | in-flight part barrier | §5.4, §6.3 | 採用 | `acceptParts=false` と barrier generation を永続化し、開始済み slot が zero になるまで complete しない。 |
| SM-04 | R2 lifecycle race | §5.4, §6.3, §13.1 | 採用 | application deadline を lifecycle より先に置き、消滅時は terminal failure とする。 |
| SM-05 | DO / D1 terminal 差 | §5.4 | 採用 | D1 node revision / operation result を正本とし、DO の committed result を修復する。 |
| SM-06 | `trash_ops` | §5.5, §11.1 | 採用 | 排他 state、claim、chunk guard、再生成 manifest、完了 / failure を表で固定した。 |
| SM-07 | `gc_candidates` / blobs | §5.6, §11.3 | 採用 | candidate / pinned / deleting / deleted、不可逆点、pin、物理精算を固定した。 |
| SM-08 | `job_leases` | §5.7, §14.2 | 採用 | epoch / fence guard と quiesce を定義し、外部副作用は対象別 protocol に分離した。 |
| SM-09 | outbox | §5.8 | 採用 | pending / dispatching / sent / completed / failed、logical job ID、retention repair を定義した。 |
| SM-10 | thumbnail と DAV lock | §10.1 | 採用 | 派生物生成は namespace lock 対象外とし、current blob CAS だけを要求する。 |
| SM-11 | backup journal | §5.9, §11.4 | 採用 | commit 順 upsert / tombstone、start / end watermark、verify、journal 保持を定義した。 |

## 6. ラウンド1採用項目の再照合

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| B-01 | §3.4, §5.2 | 採用 | D-11 の barrier を加え、不変 blob と確定点を原子的契約にした。 |
| B-02 | §5.6, §11.3–11.4 | 採用 | pin、35日 grace、ControlDO pause / epoch を補完した。 |
| B-03 | §3.2 | 採用 | tree generation と commit 内 CTE により並行循環を解消した。 |
| B-04 | §6.2 | 採用 | logical / reserved / physical ledger と share reservation を統一した。 |
| B-05 | §5.5, §11.1 | 採用 | restore / purge 排他と FK graph を完成した。 |
| B-06 | §5.2, §7.3 | 採用 | node lock、alias 解決、commit reservation を追加した。 |
| B-07 | §5.4, §6.3 | 採用 | 全失敗 terminal、part barrier、D1 優先 reconciliation を追加した。 |
| B-08 | §4.1–4.3 | 採用 | 全 operand と upload / job / share / ticket / operation key の認可を追加した。 |
| B-09 | §2.2, §14.3 | 採用 | 完全一致 allowlist と型強制まで固定した。 |
| B-10 | §7.1, §13.2 | 採用 | DAV を app password Basic のみに統一し矛盾を除いた。 |
| B-11 | §6.1, §13.1 | 採用 | size 値を §13 に一元化し、part size ごとの実効上限を表示する。 |
| B-12 | §10.2, §13.1, §18 | 採用 | Images / WASM の狭い上限と staging gate を維持した。 |
| B-13 | §5.3, §13.1, §18 | 採用（ZIP64 は後段） | subrequest と全 header 込み offset を v1 の non-ZIP64 制約へ追加した。 |
| B-14 | §5.7, §5.6, §14.2 | 採用 | lease fence と R2 副作用の安全 protocol を分離した。 |
| B-15 | §4.2 | 採用 | bootstrap fail-closed と owner 保護を維持した。 |
| M-01 | §3.5, §5.2, §13.1 | 採用 | D1 budget と atomic zero-row barrier を明示した。 |
| M-02 | §3.2, §3.5 | 採用 | `spaces.tree_generation` の保存先・更新条件を確定した。 |
| M-03 | §3.4, §7.3 | 採用 | DAV ETag に node identity を含めた。 |
| M-04 | §3.4, §11.3, §18 | 採用 | cross-owner copy を source pin 付き再開可能 multipart job にした。 |
| M-05 | §7 | 採用 | owner token、alias、commit race を含む lock semantics を補完した。 |
| M-07 | §5.8, §10.1–10.3 | 採用 | outbox terminal、変換費用 claim、node client thumb を補完した。 |
| M-08 | §6.4 | 採用 | browser resume と declared / verified checksum 分離を維持した。 |
| M-09 | §12, §13.1 | 採用 | candidate / fallback scan の数値上限を §13 に固定した。 |
| M-10 | §4.4, §13.1 | 採用 | app HMAC に epoch を含め、KDF と先行 rate limit を維持した。 |
| M-11 | §4.2 | 採用 | iss+sub、disabled、JWT fail-closed を維持した。 |
| M-12 | §4.4, §8.1–8.2, §11.4 | 採用 | typed ticket、node binding、epoch により失効巻き戻りを補った。 |
| M-13 | §10.3–10.4 | 採用 | client thumb を node key に分離し content origin 境界を維持した。 |
| M-14 | §13.1, §14.2 | 採用 | job 全体、ticket、ZIP、metadata の具体 budget を追加した。 |
| M-17 | §15.2–15.3 | 採用 | 新しい競合・状態・費用・復旧 failure gate を追加した。 |
| m-06 | §5.1, §8.3 | 採用 | public create / status / part / complete / abort を public prefix 内へ揃えた。 |

### §6 の自己矛盾・数値注意

| ID | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| CT-01 | §5.1 | 採用 | public multipart の全 route を public allowlist 内に定義した。 |
| CT-02 | §2.2, §7.1, §13.2 | 採用 | v1 DAV 認証を app password Basic のみに統一した。 |
| CT-03 | §6.2, §11.1, §11.3 | 採用 | purge は logical、GC 成功は physical の精算主体とした。 |
| CT-04 | §6.1, §13.1 | 採用 | UI は `min(partSize×MAX_PARTS, MAX_FILE_BYTES)` の実効値を表示する。 |
| CT-05 | §3.4, §18 | 採用 | 大容量 cross-owner COPY を再開可能 job に限定し、実効 throughput の拡張は §18。 |

## 7. §8 必須修正 P0 / P1

| ID | 優先度・対象 | 反映章 | 採用・不採用・後段 | 一言 |
|---|---|---|---|---|
| P0-01 | fsMutation SQL 契約 | §5.2 | 採用 | claim、step proof、barrier、failed 補償、outbox 順を TypeScript 風疑似コードで確定した。 |
| P0-02 | tree / ancestor / auth | §3.2, §5.2 | 採用 | tree generation と commit 内 CTE / 再認可を採用した。 |
| P0-03 | trash / FK | §5.5, §11.1 | 採用 | 排他 state と削除 graph を完成した。 |
| P0-04 | GC / pin / recovery | §5.6, §11.3–11.4 | 採用 | irreversible deleting、pin、pause / quiesce を定義した。 |
| P0-05 | recovery epoch | §4.4, §11.4, §14.2 | 採用 | D1 外 epoch と旧 credential / job の無効化を定義した。 |
| P0-06 | UploadDO | §5.4, §6.3 | 採用 | terminal failure、barrier、D1 truth を状態表へ集約した。 |
| P0-07 | physical quota | §6.2, §13.1 | 採用 | 失敗 / GC 待ちを含む物理台帳と headroom を確定した。 |
| P0-08 | operands / ticket | §4.1, §8.1–8.2 | 採用 | 全 ID の主体束縛と typed node-bound ticket を確定した。 |
| P0-09 | WebDAV lock | §5.2, §7.3 | 採用 | node lock、alias、commit generation、identity ETag を確定した。 |
| P1-01 | client thumb | §10.3 | 採用 | node 単位 key / auth / lifecycle に分離した。 |
| P1-02 | ZIP / metadata / transfer / generation cost | §5.3, §8.2, §10.1, §13.1 | 採用（ZIP64 は後段） | v1 の具体 budget を一元化し ZIP64 のみ §18 へ送った。 |
| P1-03 | outbox / backup journal | §5.8–5.9 | 採用 | dispatch と completion、tombstone と watermark の遷移を定義した。 |
| P1-04 | 文書矛盾 | §5.1, §6.1–6.2, §7.1 | 採用 | public multipart、DAV auth、quota 精算、part 実効値を統一した。 |

## 8. 後段項目

後段扱いはすべて `DESIGN.md` §18 に記載した。ラウンド2に直接関係するものは ZIP64、大容量 CLI / change token、Service Token の DAV 対応、cross-owner copy の上限拡張、長期 backup / 別 account replication である。v1 はそれぞれ non-ZIP64、通常 DAV 上限、app password Basic、checkpoint 付き copy job、35日 GC grace の安全側契約を維持する。
