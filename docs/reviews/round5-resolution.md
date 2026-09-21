# ラウンド5 指摘反映表

対象: `docs/DESIGN.md` v0.6。判定語は「採用」「明示的代替」「安全な縮小」のいずれかであり、未決項目は残さない。

## G01〜G11

| G-ID または §3/§4/§5 行 | 反映章 | 採用・不採用・代替・縮小 | 一言 |
|---|---|---|---|
| G01 | §3.1, §5.2, §15.3, §16 | 採用 | `_assert` の SQL error barrier、`changes()` gate と EXISTS fallback、3反例 fixtureで部分確定を排除。 |
| G02 | §4.2–4.3, §5.1–5.3, §7.3, §13.3, §14.2 | 採用 | D1 open/revoked permit、commit時失効 assertion、claimed回収、commit不明の照合 route/503契約を固定。 |
| G03 | §0.1, §11.3, §13.2, §14.2, §16 | 採用 | ControlDOだけが epoch を発行し、journalを廃止して Time Travel + watermark付き exportへ変更。 |
| G04 | §3.1–3.3, §11.1–11.3, §15.3 | 採用 | `trash_members`、全chunk fence、FK順、deleting参照拒否、blob/GC同時遷移、restore前GC quiesceを固定。 |
| G05 | §5.1, §6.1–6.3, §13.2, §14.3 | 採用 | private/public single 3-route、staging/orphan課金、late part全abort、complete/abort 409、R2 7日 lifecycleを固定。 |
| G06 | §3.1, §4.1–4.4, §5.1, §14.1 | 採用 | owner allowlist bootstrap、signup既定false、最後のadmin保護、失効表、用途別鍵/KDF record/logoutを復活。 |
| G07 | §4.2, §5.1, §8.2, §17 | 採用 | CSRF profile列、preflight、ZIP/star/shared/tags/admin/csrf/operation routeと単一 operation enumを追加。 |
| G08 | §5.1, §5.3, §10.3, §18 | 安全な縮小 | v1 client thumbnail受付を無効化し、将来のnode-bound immutable key/re-encode/CAS条件だけを保持。 |
| G09 | §6, §8, §10, §13.2, §14.2 | 採用 | 累積費用上限、非開示receipt、用途別ticket、BudgetDO、STORE ZIP、job予算、no-storeを一元化。 |
| G10 | §3.1, §12, §15.1–15.3 | 採用 | `text_norm`/`tokens` 分離、external FTS同期、scope上限、substring照合、Gallery guard、実fixtureを固定。 |
| G11 | §5.1, §7.1–7.3, §12.1, §13.2 | 採用 | DAV profileにIf論理、mount、props/XML、lock-null、protected property、411/428を固定。 |

## §3 一貫性表（30行）

| G-ID または §3/§4/§5 行 | 反映章 | 採用・不採用・代替・縮小 | 一言 |
|---|---|---|---|
| §3-01 epoch正本 | §11.3, §14.2 | 採用 | ControlDO `bumpEpoch()` の値だけをD1へ複製。 |
| §3-02 operation terminal | §5.2, §11.3 | 採用 | snapshot内terminalを保存し、restoreでfailedへ戻さない。 |
| §3-03 upload/operation state | §6.2 | 採用 | `operations.committed` と `uploads.completed` を別stateとして固定。 |
| §3-04 restore operation名 | §4.2, §5.1 | 採用 | `node.restore` に統一。 |
| §3-05 scope対応 | §4.2 | 採用 | operation→scope/action→operandの正本表を追加。 |
| §3-06 job principal | §4.1, §5.3 | 採用 | actor/credential/current grant/claim fenceを別field化。 |
| §3-07 control DDL | §3.1, §5.2 | 採用 | `control` DDLは§3.1だけを正本化。 |
| §3-08 children index | §3.1, §12.1 | 採用 | 重複indexを削除し実SELECT列を含む一つへ統一。 |
| §3-09 media列 | §3.1, §9A, §12.3 | 採用 | `duration_ms`,`dominant_color` に固定。 |
| §3-10 ref count | §3.3, §11.2 | 採用 | current+version+pinの式、増減batch、再計算式を明記。 |
| §3-11 node state guard | §5.2, §11.1 | 採用 | live mutationとrestore/purgeの状態述語を分離。 |
| §3-12 derivative key | §10.3, §18 | 安全な縮小 | v1 client thumb無効、将来はnode-bound attempt keyのみ。 |
| §3-13 automation upload | §4.1, §5.1 | 安全な縮小 | automationはv1 read-only list/metadata。 |
| §3-14 content CORS/CSRF | §5.1, §8.2 | 採用 | route別profileとOPTIONSを追加。 |
| §3-15 host用語 | §2.2, §8.2, §14.1 | 採用 | scheme/port込み `CONTENT_ORIGIN` に統一。 |
| §3-16 ETag | §3.3, §7.3 | 採用 | content/DAV metadata/collection/R2 validator表を追加。 |
| §3-17 cache | §10.4 | 採用 | 認可済み応答を `private, no-store` に固定。 |
| §3-18 R2 absent | §10.1, §13.3 | 採用 | 通常404とcommitted欠損503を分離。 |
| §3-19 runtime 1102 | §13.3 | 採用 | platform強制終了はWorkerでcatch/503変換不能と明記。 |
| §3-20 token size | §3.1, §4.4, §8.2 | 採用 | tokenはtarget集合ID+hash、本体はdurable storage。 |
| §3-21 ZIP境界 | §10.2, §13.2 | 採用 | `4,294,967,295 bytes` に統一。 |
| §3-22 backup保持 | §11.3, §13.2 | 採用 | Time Travel 30日、export日次・最大35日・最少5世代。 |
| §3-23 quota Foundation | §6.3, §16 | 採用 | quota/physical/ref/pin ledgerをPhase 1へ前倒し。 |
| §3-24 journal導入順 | §11.3, §16 | 明示的代替 | journalを廃止しTime Travel/export watermarkへ置換。 |
| §3-25 outbox Foundation | §5.3, §16 | 採用 | operation claim/outbox/repairを最初のmutationから導入。 |
| §3-26 claim fence | §4.1, §5.2–5.3 | 採用 | principal文字列でなくpermit/claim/current grantをcommit条件化。 |
| §3-27 content budget identity | §8.2, §14.2 | 採用 | `content_sessions.budget_id` と `BudgetDO` に統一。 |
| §3-28 backup operation照合 | §5.1, §11.3 | 採用 | watermark後の404を未確定・同key再送可と定義。 |
| §3-29 metric名 | §14.3, §15.1, §18 | 採用 | D1計測名を `duration_ms` に統一。 |
| §3-30 blob参照状態 | §3.1, §11.2 | 採用 | current/version/pin追加時のdeleting/deleted拒否を共通assertion化。 |

## §4 完全性表

| G-ID または §3/§4/§5 行 | 反映章 | 採用・不採用・代替・縮小 | 一言 |
|---|---|---|---|
| §4-01 toolchain exact版 | §13.5, §16.0.1 | 採用 | Node/pnpm/Wrangler/TS/Vitest/依存をexact固定し公開7日未満を不採用。 |
| §4-02 rollback/commit不明 | §5.2, §15.3 | 採用 | SQL error assertionとdurable operation照合を分離。 |
| §4-03 schema/enum/state | §3.1, §4.2, §16.1.1 | 採用 | 完全contractをPhase 1でmigration/CIの正本化。 |
| §4-04 bootstrap/signup | §3.1, §4.3 | 採用 | allowlist一回性、signup false、最後のadmin保護。 |
| §4-05 Idempotency-Key | §4.2, §5.2 | 採用 | principal/credential/space/kind/digest束縛、別payload 409。 |
| §4-06 quota/refs/journal | §3.3, §5.3, §6.3, §16 | 明示的代替 | quota/ref/outbox/claimは採用、journalだけTime Travel/exportへ置換。 |
| §4-07 key rotation | §3.1, §4.4, §14.1 | 採用 | 用途別ring、kid/KDF params、通常/緊急手順。 |
| §4-08 create/overwrite | §0.3, §3.3, §4.2, §16.2 | 採用 | schema、If-Match/revision、parent revision、ETag、衝突を固定。 |
| §4-09 COPY/MOVE | §4.2, §7.1, §16.2 | 採用 | cross-space MOVE拒否、folder COPY fixed manifest/props/全rollback。 |
| §4-10 single body | §5.1, §6.1 | 採用 | request内R2 staging stream routeを追加。 |
| §4-11 public small/0B | §5.1, §6.1 | 採用 | singleもapplication upload ID/capability/complete契約を使用。 |
| §4-12 unknown R2 attempt | §6.2 | 採用 | upload全体をabortingにし新upload IDで再開。 |
| §4-13 trash/FK | §11.1 | 採用 | live membership、全chunk fence、削除順を固定。 |
| §4-14 backup/restore | §11.3 | 明示的代替 | journal案をTime Travel第一・watermark export第二へ安全に置換。 |
| §4-15 search/cursor/stats | §3.1, §12 | 採用 | normalization版、cursor束縛、truncated、要求時bounded stats。 |
| §4-16 share/ticket/CSRF | §5.1, §8 | 採用 | action/profile/one-time CSRF/purpose/cancel/budget継承を固定。 |
| §4-17 content複数tab | §8.2 | 採用 | D1 session IDと同一budget ID再利用で既存再生を維持。 |
| §4-18 ZIP配信 | §5.1, §8.3, §10.2 | 採用 | private/public GET route、ticket/pin/STORE exact sizeを固定。 |
| §4-19 DAV | §7 | 採用 | username/If/Depth/Timeout/props/mount/statusをprofile/fixture化。 |
| §4-20 archive entry | §4.4, §5.1, §9A.2 | 採用 | index内entry IDでありbearer tokenではない。 |
| §4-21 metadata/state | §3.1, §9A | 採用 | overrideと抽出値分離、stateをuser/node/blobに束縛。 |
| §4-22 UI完了条件 | §9A, §15.3 | 採用 | Gallery/Bookshelf/Audioの表示・操作・保存をE2E化。 |
| §4-23 release運用設定 | §14.3 | 採用 | Access/resource/lifecycle/Queue/secret/監視/restore inventoryを固定。 |

## §5 削減表

| G-ID または §3/§4/§5 行 | 反映章 | 採用・不採用・代替・縮小 | 一言 |
|---|---|---|---|
| §5-01 PWA | §9, §17, §18 | 安全な縮小 | Service Workerはv1.1、v1は通常SPA。 |
| §5-02 EPUB pagination | §9A.2, §18 | 安全な縮小 | v1はscroll+TOC+CFI、paginationはgate付き。 |
| §5-03 media高度UI | §9A, §17 | 安全な縮小 | 基本操作/状態保存はv1、scrubber等はv1.1。 |
| §5-04 folder_stats | §3.1, §12 | 安全な縮小 | 永続表を外し要求時bounded集計。 |
| §5-05 service automation | §4.1, §5.1 | 安全な縮小 | v1 read-only list/metadataのみ。 |
| §5-06 client thumb | §5.3, §10.3, §18 | 安全な縮小 | v1受付無効、将来条件を明記。 |
| §5-07 重複index | §3.1, §12.1 | 採用 | children keyset indexを一つに統合。 |
| §5-08 public bundle | §9, §15.3 | 採用 | pure表示source共有可、private/server chunk混入はCI禁止。 |

## R1〜R4 の「部分／矛盾／未反映」解決

| G-ID または §3/§4/§5 行 | 反映章 | 採用・不採用・代替・縮小 | 一言 |
|---|---|---|---|
| R1 B-01 | §3.3, §5.2, §15.3 | 採用 | 不変blobとSQL-error原子的公開を結合。 |
| R1 B-02 | §11.2–11.3, §14.2 | 採用 | ControlDO epoch、Time Travel/export、GC quiesceへ統一。 |
| R1 B-03 | §3.1–3.2, §5.2 | 採用 | owner/root/blob assertionとtree CAS error barrierを追加。 |
| R1 B-04 | §6.2–6.3, §13.2 | 採用 | 失敗物理課金とshare reservationを確定。 |
| R1 B-05 | §11.1 | 採用 | live membership、既削除子除外、全FK順序。 |
| R1 B-06 | §5.2, §7.3 | 採用 | D1 permit revoke fenceで旧書込みを排除。 |
| R1 B-07 | §5.1, §6 | 採用 | single/late part/complete-abort/lifecycleを完成。 |
| R1 B-08 | §4.2, §5.1 | 採用 | 全operation/scope/operandとrouteを対応。 |
| R1 B-10 | §5.1, §7.1, §8.2 | 採用 | route別CSRF profileでDAV/contentを分離。 |
| R1 B-11 | §0.3, §5.1, §6, §7.1 | 採用 | 411/428、single、0B、part実効上限を固定。 |
| R1 B-13 | §5.1, §8.3, §10.2 | 採用 | ZIP GET、STORE manifest、同serializer exact size。 |
| R1 B-14 | §5.3, §11, §13.2 | 採用 | job/R2 claim fence、lease回収、予算を追加。 |
| R1 B-15 | §3.1, §4.3, §5.1 | 採用 | owner allowlist、signup、最後のadmin、移譲を固定。 |
| R1 M-01 | §5.2, §12, §15 | 採用 | bind/primaryに原子性と規範query fixtureを接続。 |
| R1 M-02 | §3.2–3.3 | 採用 | path hintにgenerationを持たせ現在pathを再検証。 |
| R1 M-03 | §3.3, §7.1, §11.3 | 採用 | validatorイベントとepoch非再使用を確定。 |
| R1 M-04 | §4.2, §16.2.5 | 採用 | folder COPY fixed manifest/props/衝突/全rollback。 |
| R1 M-05 | §7 | 採用 | DAV profile全項目へ展開。 |
| R1 M-07 | §5.3, §10.3 | 安全な縮小 | sent回収/claimは採用、client thumbはv1無効。 |
| R1 M-08 | §6.3, §16.0 | 採用 | handle再許可、再選択fingerprint、hash採用gate。 |
| R1 M-09 | §12.2 | 採用 | norm/token/substring/external FTS同期を固定。 |
| R1 M-10 | §3.1, §4.4, §14.1 | 採用 | versioned KDFと用途別鍵運用を追加。 |
| R1 M-11 | §4.1–4.3 | 採用 | email自動結合禁止と失効表を追加。 |
| R1 M-12 | §8.2, §10.4 | 採用 | budget継承、固定OG、no-storeを追加。 |
| R1 M-13 | §5.3, §10.3, §18 | 安全な縮小 | client thumbをv1無効化。 |
| R1 M-14 | §11.2, §13.2, §14.3 | 採用 | maintenance予算と運用回収を固定。 |
| R1 M-15 | §7.1 | 採用 | Shared予約名/stable mountを固定。 |
| R1 M-16 | §13.2, §14.1–14.3, §18 | 採用 | 保持、鍵、費用worksheet、運用inventoryを追加。 |
| R1 M-17 | §15.3 | 採用 | failure/protocol/media回帰を識別可能な一覧へ復活。 |
| R1 P0-1, P0-4, P0-5, P0-6 | §3, §5.2, §6, §11 | 採用 | 原子性・tree/quota・trash・permitを各基礎契約で解決。 |
| R1 P0-2 | §11.3 | 明示的代替 | journalでなくTime Travel/export recoveryで解決。 |
| R1 P0-3 | §4, §5.1 | 採用 | 認可とbootstrapを完成。 |
| R1 P1-1, P1-2, P1-3, P1-4, P1-5 | §5.1, §6, §10, §13, §15 | 採用 | size/surface/job/ZIP/受入回帰を全て明記。 |
| R2 D-01, D-02, D-11 | §5.2, §15.3 | 採用 | `_assert` error barrierで並行PUT/tree CASの0行をrollback。 |
| R2 D-03 | §4.3, §5.2, §6.2 | 採用 | current user/credential/shareをcommit assertion化。 |
| R2 D-04, D-05 | §11.1 | 採用 | membership/state fenceと全削除graphを固定。 |
| R2 D-06 | §3.1, §11.2–11.3 | 採用 | deleting参照拒否とR2 delete quiesce。 |
| R2 D-07 | §6.2–6.3 | 採用 | staging/orphan physical台帳を確定。 |
| R2 D-08 | §11.3, §13.2 | 採用 | 35日最大年齢+5世代+pin/quiesceを接続。 |
| R2 D-09 | §11.3, §14.2 | 採用 | ControlDO発行値をD1へ複製。 |
| R2 D-10 | §5.3, §10.3, §18 | 安全な縮小 | client thumb v1無効。 |
| R2 A-01 | §4.2, §5.1 | 採用 | non-node operandを含む完全表。 |
| R2 A-03, A-06, C-03 | §4.4, §8, §13.2 | 採用 | purpose claimと全route共通budget/継承。 |
| R2 A-04 | §8.1 | 採用 | auto rename、同形201、確定名非開示。 |
| R2 W-02, W-05 | §7.1–7.3 | 採用 | stable mount、If論理/token submission/parser上限。 |
| R2 W-03 | §5.2, §7.3 | 採用 | permit revoke完了後だけ新grant。 |
| R2 C-01 | §8.3, §10.2, §13.2 | 採用 | STORE/exact size/index byte上限。 |
| R2 C-02 | §7.1, §12.1, §13.2 | 採用 | property/COW/bulk累積上限。 |
| R2 C-04 | §6.2, §13.2 | 採用 | attempts/calls/bytes累積上限。 |
| R2 C-05 | §5.3, §11.2, §13.2 | 採用 | 実行前claimとowner/job予算。 |
| R2 SM-01 | §6.2, §14.3 | 採用 | R2 lifecycle 7日で未保存multipartを回収。 |
| R2 SM-02 | §6.2–6.3 | 採用 | 未公開完成物をorphan/physicalへ計上。 |
| R2 SM-03, SM-04 | §6.2 | 採用 | unknown part全abort、completing abort 409、deadline/lifecycle。 |
| R2 SM-06 | §11.1 | 採用 | membership/state/permit chunk guard。 |
| R2 SM-07 | §3.1, §11.2 | 採用 | ref追加拒否とblob/GC state同batch。 |
| R2 SM-08 | §5.3, §11.2–11.3 | 採用 | claim fenceとGC/recovery quiesce。 |
| R2 SM-09 | §5.3 | 採用 | D1確定後ack、sent lease repair。 |
| R2 SM-10 | §5.3 | 採用 | derivativeはnamespace lock外、publish fenceのみ。 |
| R2 SM-11 | §11.3 | 明示的代替 | 不完全journalを廃止しTime Travel/exportへ置換。 |
| R2 P0-01, P0-02, P0-03, P0-04, P0-05, P0-06, P0-07, P0-08, P0-09 | §3–§11, §15 | 採用 | 対応するD/W/A/SM契約をG01〜G07で完結。 |
| R2 P1-01 | §5.3, §10.3, §18 | 安全な縮小 | client thumb v1無効。 |
| R2 P1-02 | §6, §8, §13 | 採用 | 費用/ticket/metadataの累積上限を復活。 |
| R2 P1-03 | §5.3, §11.3 | 明示的代替 | outbox回収採用、journalはTime Travel/exportへ置換。 |
| R2 P1-04 / CT-01, CT-02, CT-03, CT-04, CT-05 | §5.1, §6, §7, §13 | 採用 | public single/multipart、DAV Basic、quota、part上限を固定。 |
| R3 A3 | §4.1, §5.1 | 安全な縮小 | service automationはread-onlyで完結。 |
| R3 A4 | §4.3, §8.2 | 採用 | 失効最大遅延、owner share、content logoutを追加。 |
| R3 Z1 | §4.2, §5.1 | 採用 | scope/operation/flowを完全表とmanifestで接続。 |
| R3 Z2 | §3.2, §12 | 採用 | EffectiveLiveをbounded規範queryへ接続。 |
| R3 Z4 | §5.2, §11.3 | 採用 | D1 permit fenceとControlDO epochで修正。 |
| R3 T1 | §4.4, §8.2 | 採用 | share expiry clampとdurable session/budgetを固定。 |
| R3 T4 | §5.1, §8.2 | 採用 | content preflight/profileで衝突解消。 |
| R3 C1 | §9A.2, §15.3, §18 | 採用 | reader資源解決/sandboxをbrowser gateとE2Eへ固定。 |
| R3 S1 | §4.3 | 採用 | owner identity allowlistとadmin保護を復活。 |
| R3 P0-01 | §4.1 | 採用 | issuer単位single-flight/counterを明記済み契約へ接続。 |
| R3 P0-02, P0-03, P0-04, P0-05 | §3–§8 | 採用 | operation、EffectiveLive、失効、token/session/CSRFを完結。 |
| R3 P0-06 | §9A.2, §15.3, §18 | 安全な縮小 | scroll reader必須、paginationはbrowser gate。 |
| R3 P0-08 | §3.3, §7.1–7.3 | 採用 | validator更新eventとDAV profileを固定。 |
| R3 P0-09 | §4.3, §5.2, §11.3 | 採用 | bootstrap/fence/recovery epochを同時に修正。 |
| R3 P1-01 | §5.1, §7.1, §13.2 | 採用 | If/Timeout/JSON/XML bounded parser上限を固定。 |
| R3 P1-02 | §3.1, §4.4, §14.1 | 採用 | 100k代替を維持しversioned KDF/rotationを追加。 |
| R4 P0-01 | §3.1, §5.2, §15.3 | 採用 | complete contract要求とSQL error barrierを固定。 |
| R4 P0-02 | §5.1–5.2, §7.3 | 採用 | commit不明照合とD1 permit fenceを完成。 |
| R4 P0-03 | §6.2–6.3 | 採用 | upload副作用/課金/late attemptを完成。 |
| R4 P0-04 | §11.1–11.2 | 採用 | trash membership、FK、GC state/参照/quiesceを完成。 |
| R4 P0-05 | §5.1, §8.2, §9A.2 | 採用 | CORS/CSRF/reader契約を完成。 |
| R4 P0-08 | §11.3 | 明示的代替 | FTS除外exportを維持し、epoch/整合点はTime Travel+watermarkで修正。 |
| R4 P1-01 | §13 | 採用 | 単位/累積上限/error mappingを統一。 |
| R4 P1-02 | §3.1, §12, §15.1 | 採用 | index/query/rows budgetを実SELECTへ整合。 |
| R4 P1-03 | §8.2, §14.2 | 採用 | BudgetDO TTL/alarm/storage/repairを固定。 |
| R4 P1-04 | §5.1, §7, §15.3 | 採用 | flow完結routeとDAV規範fixtureを追加。 |
| R4 P1-05 | §16 | 採用 | quota/ref/outbox/claimsをFoundationへ前倒し。 |
| R4 §1.3 upload budget | §6.2, §13.2 | 採用 | data/control/cleanup counterを分離。 |
| R4 §1.3 archive index | §13.2 | 採用 | archive index JSON≤8MiB。 |
| R4 §1.3 metadata capacity | §7.1, §13.2 | 採用 | COW/dead props/bulk累積上限を復活。 |
| R4 §2 Queue semantics | §5.3 | 採用 | D1 terminal確定後だけack。 |
| R4 §4.1 完全制約 | §3.1, §5.2 | 採用 | owner/root/blobをapp assertion + repairで保証。 |
| R4 §4.2 FTS同期 | §12.2 | 採用 | base+external FTS insert/update/deleteを同batch化。 |
| R4 §7.2 grant/scope | §4.2 | 採用 | 全operation対応表を正本化。 |
| R4 §7.3 same part | §6.2 | 採用 | unknown旧I/Oはupload全体aborting。 |
| R4 §7.5 ticket更新 | §8.2 | 採用 | 同user+shareのbudget IDを継承。 |
| R4 §1.2 最終part/0B | §6.1, §13.2 | 採用 | 0Bはsingle固定、multipart最終partは>0。 |
