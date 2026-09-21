R5 の指摘と v0.6・是正記録・実装ブリーフを突き合わせ、G01 は SQLite インメモリで実行検証します。ファイルは変更せず、G01〜G11 と既定のゲート条件に限定して判定します。主要な是正方針は本文に反映されています。ただし、EXISTS fallback の証明条件、復旧時の epoch／R2 副作用の扱い、single upload と CSRF の入口契約には確認すべき点が残っています。ここから掲載 SQL の3反例を実行し、「設計上の是正」と「実証済み」を分けて整理します。SQLite 3.45.3 では、G01 の3反例すべてで transaction 前後の全行が一致し、副作用ゼロを確認しました。一方、後置の状態確認だけを使う EXISTS fallback には tree CAS の0行更新を見逃す反例があり、掲載 permit assertion は期限切れでも `open` の行を通しました。また、purge 順序にない `trash_members` の FK が node 削除を阻止することも確認しました。これらを Phase 0／1 で閉じる条件として整理します。# 再ゲート判定：条件付き Go — Phase 0 → 1 に限定

**G01 の主要な原子性欠陥は、SQLite で是正を確認しました。** 一方、v0.6 と是正記録の「是正済み」を、そのまま全項目の解決認定にはできません。残件は下記の **10 条件を Phase 0／1 内で確定すること**を条件とします。

ファイルは編集していません。実行検証は SQLite インメモリのみで、実 D1・Cloudflare staging・実ブラウザの合格を意味しません。「解決」は設計指摘の解決であり、後続 phase の実装・受入試験を免除しません。

## 1. G01〜G11 の判定

| ID | 判定 | v0.6 本文の引用 | 一文の理由 |
|---|---|---|---|
| **G01** | **部分** | 「各必須 statement」は「**直後**に影響行 assertion」、「EXISTS 型 assertion のみ」を fallback とする。[DESIGN.md:587-624](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md) | `changes()` 主方式で3反例の副作用ゼロを確認したが、後置の EXISTS だけでは更新実行を証明できず、fallback の契約が不足する。 |
| **G02** | **部分** | 「`open→revoked`」と「同 permit の…`claimed` だけを `failed` にしてから、新 permit を発行」。[DESIGN.md:559-628](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md) | revoke を D1 で線形化する方式は成立するが、掲載 assertion に permit の時刻期限がなく、現在 scope・role・session 等の認可条件も完全な SQL 契約にはなっていない。 |
| **G03** | **部分** | 「**ControlDO が唯一の epoch 発行者**」、「snapshot に存在する committed/failed operation の terminal state を保存」。[DESIGN.md:950-961](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md) | 通常復旧の epoch 巻戻りと terminal 改変は是正されたが、ControlDO storage 喪失時の再初期化式、R2 副作用の収束、FTS を除外する export 手段に残件がある。 |
| **G04** | **部分** | 「同時点で live な root+descendant だけ」を membership に確定し、「全 descendant tagging/restore/purge chunk」を fence する。[DESIGN.md:913-948](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md) | membership・参照追加拒否・GC 同時遷移は改善したが、掲載 FK 削除順序には `trash_members` 自身などがなく、実際に node 削除が FK 違反になる。 |
| **G05** | **部分** | single body は「**その request 内**」で保存し、「R2 実在確認後すぐ physical を一度だけ計上」。[DESIGN.md:642-667](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md) | private/public single・0B・失敗完成物の課金方針は定まったが、single の遅延 PUT と abort/期限切れの競合、および不明 I/O 中の予約・課金遷移が未確定である。 |
| **G06** | **部分** | bootstrap は「`OWNER_EMAILS` または `OWNER_IDENTITIES`…へ一致」、最後の admin は「SQL assertion で拒否」。[DESIGN.md:328-361](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md) | bootstrap allowlist・signup 既定 false・admin 保護・鍵運用は復活したが、`access-session` の具体的な個体識別と D1 失効・job 継続判定への対応が残る。 |
| **G07** | **部分** | `/session` の POST/OPTIONS は固定 allowlist CORS、`public-form` は「one-time public CSRF」。[DESIGN.md:497-517](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md) | cross-origin/preflight の旧衝突は解消したが、CSRF の初回発行・再取得と、share/DAV credential による operation 照合のフローが閉じていない。 |
| **G08** | **解決** | 「**v1 は client thumbnail 受付を無効化し route/result row/key を作らない。**」[DESIGN.md:883-885](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md) | 受付自体を外す明示的な安全縮小により、v1 の COW 汚染経路を除去している。 |
| **G09** | **部分** | session 更新・別 tab は「既存 `budget_id` を再利用」、「全 byte/request/HEAD/Range」を同じ BudgetDO に接続。[DESIGN.md:810-823](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md) | 経路被覆・継承・累積制限は復活したが、budget と session の上限単位、消費 counter の復元・不明転送の精算、job 全体予算が不足する。 |
| **G10** | **解決** | 「最終 substring」は escaped `text_norm LIKE`、scope 自体に `LIMIT 10000`、Gallery は current blob と generator を guard。[DESIGN.md:1006-1055](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md) | 正規化・原文/token 分離・FTS 同期・探索上限・世代検査・PROPFIND 増幅 fixture が設計へ戻っており、残る実 D1 性能測定は既定 gate として扱える。 |
| **G11** | **部分** | If の「評価結果とは別に」token submission を検査し、PROPPATCH は「D1 は全 rollback」。[DESIGN.md:675-697](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md) | 主要な DAV 防御は復活したが、Basic username、method ごとの必須条件 header、DAV の GET/PROPFIND/条件照合に使う validator の対応が確定しきっていない。 |

## 2. G01：SQLite 実行結果

### 検証方法

- **Python 3.12.8／SQLite 3.45.3、`:memory:`、FK 有効**。
- §3.1 の `_assert` と関連 DDL、§5.2 の node／tree／quota／outbox／operation terminal の掲載 statement を実行。
- SQL error 時に transaction 全体を rollback する batch 相当の実行器を使用。
- transaction 前後で、fixture 内の **全 table の全行**を比較。
- trash の具体的な root 更新 SQL は本文で省略されているため、§11.1 の不可視化・state 更新を最小 SQL に具体化し、掲載どおり直後に `_assert` を配置しました。**完全な trash 実装の検証ではありません。**

| R5 の反例 | SQL 実行結果 | rollback 後 |
|---|---|---|
| node revision 不一致 | node UPDATE＝0行、直後に `CHECK constraint failed: v = 0` | node／tree／quota／outbox を含め全行不変 |
| tree generation 不一致 | node UPDATE＝1行、tree UPDATE＝0行、直後に CHECK 違反 | 先行 node 更新も取り消され、全行不変 |
| trash root revision 不一致 | root UPDATE＝0行、直後に CHECK 違反 | root は live、`trash_ops.state='pending'`、全行不変 |

正常系は `committed` になりました。追加で **quota UPDATE＝0行、outbox UNIQUE 違反、operation terminal UPDATE＝0行**も検証し、すべて全行不変でした。

なお、SQLite の CHECK 違反そのものは、常に transaction 全体を自動 rollback するものではありません。今回は **SQL error を受けた batch 実行器が全 rollback**しています。これは [D1 の公開 `batch()` 契約](https://developers.cloudflare.com/d1/worker-api/d1-database/)に対応します。

**D1 batch 内で `changes()` が直前 statement を指すかは、要確認（Phase 0 gate）です。**

### EXISTS fallback は単独で十分か

**方式としては成立可能ですが、本文の「各 statement の後」に置く状態確認だけでは不十分です。**

反例は、実際の tree generation が `8`、期待値が `7` の場合です。

```sql
UPDATE spaces SET tree_generation=tree_generation+1
WHERE id='s' AND tree_generation=7;

INSERT INTO _assert(v) SELECT 1 WHERE NOT EXISTS (
  SELECT 1 FROM spaces WHERE id='s' AND tree_generation=8
);
```

UPDATE は0行ですが、後置 assertion は成功します。この型の fallback を代表 batch に組み込むと、実際に **node／quota／outbox が変更され、operation が `committed`** になりました。

これは未掲載の fallback 完成 SQL を検証したのではなく、**本文が許してしまう後置確認方式の反例**です。node の `last_op_id` だけでは tree／quota 等まで証明できません。

必要なのは、同一 transaction 内での更新前条件と更新後条件、または実更新と不可分な operation 固有の証跡です。今回、tree の更新前 EXISTS assertion を追加した場合は、同じ反例を rollback できました。

## 3. 是正で残った矛盾・抜け

### G02：D1 revoke fence は有効。ただし「期限切れ」と区別が必要

掲載 SQL について、以下を確認しました。

- `state='revoked'`：assertion 失敗、全 rollback。
- **過去の `expires_at` でも `state='open'`：commit 成功。**

`o.claimed_expires_at=p.expires_at` は値の一致であり、現在時刻との比較ではありません。§14.2 の「全requestでexpiryを検査」だけでは、検査後に停止・再開した Worker を commit 時点で拒否できません。

これは「revoke 後に旧 Worker が新 LOCK を突破する」という反例ではありません。**revoke の線形化は改善していますが、期限切れ時点から拒否するという契約は別途 SQL で閉じる必要があります。**

### G03：通常復旧は改善したが、二つの安全性保証が強すぎる

1. **storage 喪失時の epoch 式は非再使用を保証しません。**  
   `max(復元D1 epoch, 現在時刻秒)+1` は、過去の ControlDO 発行済み最大値を知りません。例えば同じ秒 `T` に旧 D1 snapshot を基に再初期化を繰り返すと、どちらも `T+1` になります。安全な下限を証明できない場合の fail-closed が必要です。

2. **R2 delete の lease 期限経過は、外部 I/O 完了の証明ではありません。**  
   §11.3 手順2は期限経過を待って restore しますが、遅延していた旧 delete が後から完了する問題を閉じていません。§11.1 の通常 restore には `gc_candidates.deleting=0` もあり、両復旧経路の収束条件も揃っていません。

加えて、[D1 export の公式制約](https://developers.cloudflare.com/d1/best-practices/import-export-data/)には virtual table を持つ DB の制限があります。**「FTS を export しない」という宣言だけでは、採用した `wrangler d1 export` の実行方法と整合 snapshot を保証できません。** 通常 table の抽出方法・barrier の保持範囲を確定する必要があります。journal の復活を要求するものではありません。

### G04：新設 membership の FK が purge 表から抜けている

`trash_members.node_id REFERENCES nodes(id)` が存在する一方、§11.1 の削除順序には `trash_members` がありません。membership を持つ node の削除を実行すると、**`FOREIGN KEY constraint failed`** になりました。

`node_props` 等の参照も完全 schema と照合が必要です。また、membership から除外した「別 trash operation の既削除子」が親を参照したままなら、親 purge をどう収束させるかも必要です。単に「子→親」では解決しません。

### G05：`blobs.state` 台帳は採用可能だが、外部 I/O 不明状態が残る

`physical_charge_state` を廃止しても、**blob の条件付き状態遷移と physical 増減を同一 batch に結合**すれば、一度だけ課金する台帳は実装できます。

不足するのは次の境界です。

- single PUT の結果不明中、同一 key への再 PUT／delete／予約解放をいつ許すか。
- `head()` が一度 absent だったことを、未完了 PUT の不存在と扱わないこと。
- `completing` の abort は409なのに、一般行の `nonterminal→failed|expired|aborted` がどこまで適用されるか。
- 台帳記録前に停止した完成物を、予約または physical のいずれで継続会計するか。

multipart の「結果不明なら upload 全体を abort」という規定だけでは、single の遅延書込みを閉じられません。

### G06／G07：入口は増えたが、session と CSRF の初期化が未接続

bootstrap allowlist 自体には、R5 の先着 admin 問題を再発させる記述はありません。一方、`credential_id=access-session` の具体化がなく、**どの login session を logout・失効・job 継続判定の対象にするか**は残っています。

CSRF には次の入口問題があります。

- `POST /api/v1/csrf` 自身が、one-time CSRF を要求する `same-origin-json`。
- public unlock 等も one-time public CSRF を要求するが、初回発行・再取得方法がない。
- operation 照合 GET は `auth=access` のみで、share/DAV の「同 credential で照合」と一致しない。

preflight の追加そのものは正しい是正です。必要なのは CSRF を外すことではなく、**発行時の信頼条件と、消費対象 route を分けること**です。

### G09：BudgetDO の単位と精算が未確定

- §8.2 は同一 `budget_id` に集約する一方、§14.2 は `parallel≤8/session`。共有 budget と session のどちらで8本を数えるかを統一する必要があります。
- D1 の session／budget ID だけでは、既消費 byte/request counter は復元できません。eviction 後も DO 永続 counter を保持する契約が必要です。
- 応答喪失・alarm 回収時の「精算」が、消費量不明の転送まで返金する意味なら、budget を再利用できてしまいます。
- 匿名 share の budget identity、owner 別 claim 上限の数値、**job 全体**の累積予算は未確定です。

## 4. R5 §3・§4 の再照合

| 対象 | 是正を確認した点 | 残る点 |
|---|---|---|
| **§3 一貫性表** | operation 名、control DDL、children index、media 列、ref count 定義、operation 別 node guard、client thumb／automation の縮小、no-store、ZIP 境界、journal 代替、Foundation への台帳前倒し | epoch 喪失時の保証、BudgetDO の単位、access session identity、DAV validator の適用先、ControlDO 導入順 |
| **§4 完全性表** | exact toolchain 方針、single/public 0B、主要 route、ZIP 配信、失効表・鍵運用、FTS、UI 受入項目、運用 inventory | EXISTS fallback、完全 FK 削除 graph、single 不明 I/O、CSRF 初期化、全 credential の結果照合、具体的な復旧・会計契約 |

`round5-resolution.md` は追跡表として有用ですが、**「採用」は本文の安全性成立を証明しません**。特に G01/G04/G05/G07/G09 の「完成」「全て固定」という評価は、上記残件を踏まえて読み替える必要があります。[round5-resolution.md:5-82](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/reviews/round5-resolution.md)

## 5. R5 §7「最終ゲートの通過条件」6項目

| # | 通過条件 | 達成状況 |
|---|---|---|
| 1 | 原子性の是正 | **部分達成**：3反例と追加の代表失敗は SQLite で副作用ゼロ；実 D1 の `changes()` と、全必須 step／fallback の保証は未完了。 |
| 2 | fence／認可の線形化 | **部分達成**：D1 revoke-first は採用済み；期限・現在認可の完全述語と reset／停止再開 fixture が必要。 |
| 3 | 復旧契約の修正 | **部分達成**：ControlDO 単一発行・terminal 保存・Time Travel 代替は反映；storage 喪失、R2 quiesce、export 手段が残る。 |
| 4 | upload／quota／trash／GC の完成 | **部分達成**：主要フローと台帳方針は反映；single 不明 I/O と FK 削除・独立 trash の収束が残る。 |
| 5 | 認証・API のフロー完成 | **部分達成**：allowlist・rotation・失効表・preflight は復活し、automation/client thumb は安全縮小；session identity・CSRF・結果照合が残る。 |
| 6 | 回帰台帳を本文へ反映 | **部分達成**：対応表と §15.3 の受入一覧は整備されたが、今回の残件を「解決済み」としたままでは受入条件が不足する。 |

**6項目の全面通過とは認定しません。** ただし、未実装の media／DAV／browser 等の release 試験を Phase 0／1 の前提へ繰り上げることもしません。

## 6. IMPLEMENTATION_BRIEF の整合性と、Sol に不足する事項

ブリーフは、journal 廃止、service read-only、client thumbnail 無効、台帳・permit・claim/outbox の Foundation 導入について v0.6 と一致しています。

ただし、二点は修正判断が必要です。

- 冒頭の **「R5 ゲート項目を是正済み」**は、本再判定では成立しません。[IMPLEMENTATION_BRIEF.md:3-10](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/IMPLEMENTATION_BRIEF.md)
- ブリーフは ControlDO を認証・permit・最初の create より先に置きますが、DESIGN の依存表では ControlDO を含む1.6が、最初の create を含む1.5に依存しています。**最初の mutation から epoch/fence を適用する順序**へ統一してください。[IMPLEMENTATION_BRIEF.md:55-58](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/IMPLEMENTATION_BRIEF.md) [DESIGN.md:1400-1406](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

### 条件付き Go の条件：最大10件

以下は新機能ではなく、既存 G01〜G11 の契約確定です。

1. **Phase 0：SQL barrier を実 D1 で確定する。**  
   `changes()`・SQL error 全 rollback・応答喪失分類を検証し、fallback を使うなら更新前条件／実更新証跡を含む方式で3反例と全必須 step を通す。

2. **Phase 1：permit と現在認可の commit 述語を完成させる。**  
   期限、epoch、space、operation、principal/credential の対応、および role/scope/version/session 失効を具体的な SQL と競合 fixture にする。

3. **Phase 1：Access session の個体識別を確定する。**  
   `credential_id`、D1 session、logout、content session 発行元、job 継続資格を一意に対応付ける。

4. **Phase 1：復旧の安全条件を確定する。**  
   ControlDO 喪失時に非再使用を証明できない場合の拒否、期限経過だけに依存しない R2 副作用収束、FTS 除外 export の実現手段と snapshot 境界を定める。

5. **Phase 1：完全 FK graph と purge fixture を確定する。**  
   `trash_members`、`node_props` 等の全参照、および別 trash operation の子が残る場合を含め、掲載削除順序を成立させる。

6. **Phase 1：single を含む upload 台帳・外部 I/O 状態遷移を固定する。**  
   遅延 PUT、abort/deadline、reservation 維持／解放、staging/orphan physical charge の一度だけ更新を、相互に矛盾しない遷移表にする。

7. **Phase 1：CSRF と operation 照合のフローを閉じる。**  
   private/public CSRF の初回・再取得条件を定め、share/DAV も既存の同一-key 再送契約等によって同 credential で結果確認できるよう契約を統一する。

8. **Phase 1：BudgetDO と累積予算の契約を数値・状態で固定する。**  
   上限単位を `budget_id` に統一し、匿名 identity、永続 counter、結果不明転送の精算、owner claim／job 全体上限を定める。

9. **Phase 1：DAV protocol contract の残欄を埋める。**  
   Basic username、Timeout、method 別の必須条件 header と validator を固定し、DAV `getetag` と当該 GET の ETag を一致させる。

10. **Phase 1：ブリーフの開始条件・依存順・回帰対応を本判定へ合わせる。**  
    最初の create より前に必要な ControlDO/auth/ledger/fence を揃え、上記条件に最小受入 fixture を対応付ける。

完全 schema／migration が Phase 1 成果物として未作成であること自体は、No-Go 理由にしません。ただし、これらの安全性判断を Sol の推測に任せてはいけません。

## 最終判定

**条件付き Go。**

- **Phase 0 の着手を許可します。**
- **Phase 1 の contract・migration・最小実装／fixture 作成も許可します。**
- 上記10条件を **Phase 0／1 内で確定・検証し、Phase 1 完了前に閉じること**を条件とします。
- それまでは「v0.6 をそのまま確定契約として採用済み」と扱わず、Files core 以降へ進めません。

主たる原子性方式は実証でき、残件は既存方式の述語・状態遷移・依存順を確定する範囲です。そのため **Phase 0／1 着手そのものを止める No-Go とはしません**が、無条件 Go でもありません。
