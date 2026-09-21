設計書 v0.5 と各ラウンドの指摘・解決記録を照合し、採用済みの重大指摘を全件追跡します。ファイルは変更せず、最終判定と Sol 向け引き渡し指示書の草案を日本語で出力します。採用済み項目の照合で、重大な回帰を確認しました。特に §5.2 は、D1 batch の一部更新が確定した後に `meta.changes` を検査するため、失敗扱いにしてもデータの原子性を保てません。また、復旧 epoch の更新手順が「ControlDO を正本とする」という規定と矛盾しています。これらを最小例で検証し、対応表上の「採用」と本文で実際に保証される内容を分けて報告します。インメモリ SQLite で掲載 SQL の反例を再現しました。node 更新が 0 行でも quota と tree generation が確定するケース、tree CAS が 0 行でも operation が `committed` になるケース、root が live のまま trash が `trashed` になるケースがあります。

また、以前採用された client thumbnail の node 単位分離、転送・メタデータの累積上限、鍵ローテーション、Shared mount 仕様の一部が v0.5 では欠落しています。引き渡し草案では、これらの修正ゲートを最初に置き、認可・quota・journal を後続機能より先に実装する順序を示します。# ラウンド5 — 最終設計レビューと Sol 引き渡し判定

## 最終判定：**No-Go**

**v0.5 を「確定済みの実装契約」として Sol に渡すことはできません。**  
限定した Phase 0 の検証実装には進めますが、Files core・認可・復旧・GC の本実装を開始する前に、後述の修正ゲートを通す必要があります。

主因は機能不足ではなく、次の安全性契約の不成立です。

1. **D1 の部分更新を、commit 後の件数検査で取り消せる扱いになっている。**
2. **LockDO permit の期限回収が、旧 D1 書込みを禁止する仕組みになっていない。**
3. **復旧 epoch の更新元が、ControlDO 正本という規定と矛盾する。**
4. **失敗 upload、trash／restore／purge、GC の台帳・競合条件が不足している。**
5. **以前採用した防御の一部が、v0.5 の圧縮・再編成で欠落している。**

特に R4 の「確定方針」に忠実に従った結果として残った問題があります。**改訂指示への適合と、設計の安全性成立は別に判定しています。**

### 確認範囲

- 設計書全文、R1〜R4 のレビュー・対応表、レビュー履歴を照合。
- R4 改訂指示も読み、意図的な仕様変更と回帰を区別。
- SQLite 3.45.3 のインメモリ DB で、掲載 SQL の関連部分を検証。
- D1 `batch()` の transaction／rollback 条件を公式資料で再確認。
- Cloudflare staging、実ブラウザ、実 WebDAV クライアントの試験は未実施。
- **リポジトリのファイルは編集・作成していません。以下の指示書も草案の出力のみです。**

---

# 1. 引き渡しを止める主要指摘

以下の `G01`〜`G11` は本レビューで付与した ID です。後段の全件照合表から参照します。

## G01 — `fsMutation` が原子的でない【致命】

**該当：§5.2、§11.1、§15.3、§16・0.2**

`UPDATE ... WHERE ...` が 0 行でも SQL error にはなりません。したがって、§5.2 の最終 UPDATE は、失敗時に先行変更を rollback する barrier ではありません。

掲載された代表 statement と node proof を使った最小 batch で、次を再現しました。

| 注入条件 | batch 内の結果 | 別 batch の failed 補償後 |
|---|---|---|
| node の revision 不一致 | node 0行、tree 更新1行、quota 更新1行、proof／barrier 0行 | operation は `failed` だが、tree と quota の変更が残る |
| tree generation 不一致 | node1行、tree0行、quota1行、node proof1行、barrier1行 | operation は `committed`。failed 補償は0行で、更新と outbox が残る |
| trash root の revision 不一致 | root 更新0行、trash operation 更新1行 | **root は live のまま `trash_ops.state='trashed'`** |

全更新に proof を追加しても、最終 barrier が 0 行になるだけなら、**先行更新が残る問題は解決しません**。

`meta.changes` の検査は診断には使えますが、transaction 成立条件の代わりにはなりません。公式仕様も「statement が失敗した場合」の rollback を規定しており、0 行を失敗とはしていません。

**確定案：** 必須条件・必須更新の不成立を同一 batch 内で SQL error にする無条件 assertion／trigger／制約を設け、JS の件数検査は二次検査に限定する。

R4 対応表では、この SQL-error barrier が「確定方針優先」で不採用です。したがって、**その方針自体の再承認が必要**です。

根拠：  
[DESIGN.md:491-570](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)  
[round4-resolution.md:166-172](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/reviews/round4-resolution.md)

## G02 — commit 認可・permit・claim の収束契約が未完成【致命／重大】

**該当：§4.2〜4.3、§5.2〜5.3、§7.3、§14.2**

### 1. 認可を commit 条件へ接続する SQL がない

掲載 UPDATE は principal／credential の**文字列一致**を確認していますが、以下の現在状態を同じ transaction で保証していません。

- user の停止・role 変更
- credential の失効・期限・scope
- share の version・session・権限
- service mapping の停止・mapped user の権限

`authorize` と request 時の primary read は必要ですが、**その後の失効と commit の競合を閉じません**。

### 2. permit の「照合」は fence ではない

次のケースの扱いがありません。

1. permit を取得。
2. claim の D1 INSERT 前に Worker が停止。
3. permit が期限切れ。
4. LockDO が D1 を読むと operation は存在しない。
5. permit を解放して新しい LOCK を許す。
6. 旧 Worker が再開し、同じ epoch で claim／mutation を実行。

operation が `claimed` の場合も、「読んだ後に旧 batch が実行されない」保証が必要です。逆に terminal 以外を永久保持すれば、quiesce が完了しません。

### 3. claim 再送だけでは処理が進まない

`ON CONFLICT DO NOTHING` の再送は、既存 `claimed` を terminal に変えません。

- 再実行主体の lease／fence
- 再実行に必要な durable intent
- claim 前に停止した permit の tombstone
- abandoned claim の期限・回収
- outbox がまだない operation の発見経路

が未定義です。

**確定案：** D1 に現在 permit／実行 fence を保持し、各 commit が一致を検証し、期限回収は旧 fence の無効化または terminal 確定を D1 で完了してから LOCK を公開する。

**追加案：** commit 不明は rollback と区別し、有限時間で `COMMIT_UNKNOWN` と同一 operation ID による照合手順へ移行する。「終端確定まで絶対に5xxを返さない」は障害・切断時の HTTP 契約として保証しない。

## G03 — 復旧 epoch と backup の整合点が矛盾する【致命】

**該当：§0.1、§11.3、§13.2、§14.2、§16・4.3**

### epoch の巻戻り

§0.1／§14.2 は **ControlDO が epoch 正本**です。しかし §11.3 は、復元した D1 の `control.epoch += 1` を ControlDO へ同期します。

例：

```text
復旧直前の ControlDO epoch = 10
復元した backup の D1 epoch = 4
設計どおり D1 を +1          = 5
ControlDO に同期             = 5
```

これでは過去 epoch を再使用します。旧資格情報・job・HTTP request の排除根拠が崩れます。

### backup に取り込んだ commit を failed にする

§11.3 は end watermark まで journal を適用した後、**backup 開始 barrier 以降の operation を failed にする**としています。

これでは、snapshot に反映された namespace／quota／outbox と operation の結果が一致しません。さらに §5.2 の「committed は failed へ戻さない」とも衝突します。

### journal と保持期間

- journal の schema、commit 順 sequence、全対象 table、after-image／tombstone の形式がない。
- namespace 以外の失効・quota・outbox 更新を含める保証がない。
- `backup5世代` は `5日` と同じではない。backup 失敗が続くと、最古世代は35日 grace より古くなり得る。
- 復旧対象 blob と進行中 R2 delete の quiesce 条件が不足。

**確定案：** 新 epoch は maintenance 中に ControlDO で単調増加させて D1 へ複製し、backup は明示的な commit watermark の状態として復元し、反映済み operation の terminal state は保存する。

根拠：  
[DESIGN.md:882-901](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)  
[DESIGN.md:1228-1236](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

## G04 — trash／restore／purge／GC の競合・参照契約が欠落【致命／重大】

**該当：§3.1〜3.3、§11.1〜11.3**

state 名は統一されましたが、R2 で採用した次の契約が本文から落ちています。

- 後から親を trash にしても、以前に削除済みの子を同じ delete operation に取り込まない。
- root 不可視化後の descendant tagging と restore／purge の排他。
- 全 chunk の state／operation／fence guard。
- upload の親参照、別 trash operation の子、media／search／share 等を含む FK 削除順序。
- `deleting` blob への新規参照・pin 追加の原子的拒否。
- `blobs.state` と `gc_candidates.state` の同時更新。
- GC の進行中 R2 delete を収束させてから restore を開始する条件。

§11.1 の「子→親」は、**nodes 以外からの FK を処理する契約ではありません**。

また関連 DDL の最小検証では、次が受理されました。

- `quota_bytes=-1`
- space owner と異なる owner の root
- 別 owner かつ `state='deleting'` の blob を current blob にする node

アプリで補うことは可能ですが、**掲載 DDL と掲載 mutation SQL の組合せでは保証されていません**。

**確定案：** trash membership／manifest を確定して chunk を fence し、restore の最終公開まで旧 grant を失効させ、全参照追加が `deleting/deleted` を拒否する共通 SQL を採用する。

## G05 — upload の single 経路・失敗課金・外部 I/O 収束が未定義【重大】

**該当：§5.1、§6.1〜6.3、§14.2**

### single PUT

§6.2 は first body で `uploading`、complete 時に single `put()` と読めますが、その間の body の保存先がありません。

- 新規 single upload の body を送る endpoint
- public upload-only の小ファイル／0 byte 経路
- body を R2 へ書く時点と metadata complete の分離

を固定する必要があります。

### 失敗 blob の課金

`physical_bytes` は staging／orphan／GC 待ちを含む「実在 R2 bytes」ですが、増額は `completed` batch とされています。

R2 完成後に認可／CAS が失敗した blob について、

- 予約を保持するのか
- physical charge へ移すのか
- いつ logical charge するのか

が決まっていません。`physical_charge_state` という列名だけでは台帳になりません。

### 同一 part の遅延書込み

「旧 attempt lease 終了前に新 attempt を開始しない」は、**lease 終了後に旧 R2 I/O が完了しない保証ではありません**。

さらに、`nonterminal→aborted` は `completing` も含むため、R2 complete と abort の競合処理が必要です。

### orphan 回収

R2 multipart 作成後、upload ID 永続化前の停止について、「Cron が abort」とだけあります。**未保存 upload ID の発見・回収経路が定義されていません**。

**確定案：** single body は受信 request 中に不変 staging key へ stream し、失敗完成物も予約または物理台帳に残し、結果不明の part／complete を新規試行と並走させず安全に失敗終端へ収束させる。

## G06 — bootstrap と資格情報ライフサイクルの回帰【重大】

**該当：§4.1〜4.4、§13.4、§14.1**

### bootstrap

§4.3 は「Google IdP＋MFA の初回 identity」を admin にする規定ですが、**初回 identity が `OWNER_EMAILS` または固定 identity allowlist に一致する条件がありません**。

`OWNER_EMAILS` は vars に存在するだけで、bootstrap 後に無視することしか本文にありません。R1 B-15 の「最初にアクセスした人が管理者になる」問題を再び排除できません。

以下も消えています。

- bootstrap 前の signup 閉鎖
- signup の既定 false
- 最後の admin の停止・削除禁止
- 管理者移譲・復旧の契約

### 資格情報

- 用途別 key inventory、通常／緊急 rotation 手順がない。
- KDF version／iterations の各 password record への保存が未定義。
- `access-session` の具体的 credential identity と job 継続条件がない。
- user 停止時に、その user 所有の public share を停止するか不明。
- app logout から別 host の content session を失効させる契約がない。

**確定案：** bootstrap は事前承認 identity のみ一回許可し、認証・share・job・content session の失効表と用途別鍵の rotation 表を復活させる。

## G07 — 「完全 route manifest」だけでは主要フローが完結しない【重大】

**該当：§4.2、§5.1、§8.2、§9、§17**

### content session が共通 CSRF 規則と衝突

§8.2 の app→content `/session` は cross-origin fetch です。一方 §5.1 は JSON mutation に `Sec-Fetch-Site:same-origin` を要求します。

加えて JSON の cross-origin POST には preflight が必要ですが、**content の `OPTIONS /session` が manifest にありません**。未知 method は404という規定と両立しません。

### service upload が完結しない

service は `/api/v1/automation/*` のみ許可されますが、upload は create route しかありません。part／status／complete／abort は access または share route です。

### その他の入口不足

- ZIP 作成後の配信 route
- public ZIP 作成・消費契約
- Starred の更新
- Shared 一覧と DAV mount の対応
- tags の管理
- user 停止・admin 移譲・管理 lock 強制解除
- one-time CSRF の発行・再取得
- operation 結果照合
- public edit の MOVE を提供するかの明示

また `scope enum` に対する全 operation の対応がなく、`trash.restore` と認可表の `node.restore`、`state.write` 等の意味が確定していません。

**確定案：** route ごとに request／response schema、必要 scope、CSRF profile、状態遷移を持つ正本を作り、service・public・content の各フローを入口から終端まで機械検査する。

## G08 — client thumbnail の COW 汚染対策が消えている【重大】

**該当：§3.3、§5.3、§10.3**

R2 D-10／P1-01 で採用された、**client thumb の node 単位 key・認可・削除管理**が v0.5 にありません。

むしろ次の記述があります。

- result claim：`(kind,blob,variant,generatorVersion)`
- 「固定 client thumb key」の上書き競合を CAS

COW の二つの node が同一 blob を参照すると、片方だけの write 権限で他方の表示を変更する問題を再発させます。また固定 key の上書きは derivative 不変規則とも矛盾します。

**確定案：** server derivative と client thumb を別 result 型とし、後者の claim／key／公開 CAS／削除単位に `node_id` を必須化し、保存 key は attempt を含む不変 key とする。

## G09 — 採用済みの費用・非開示・ticket 防御が部分的に欠落【重大】

**該当：§6、§8、§10、§13、§14.2**

本文から消えた、または強制箇所がない主な契約です。

| 対象 | 欠落・不足 |
|---|---|
| upload | part ごと3 attempts、累積 part calls ≤ parts×3、累積 bytes ≤ declared×3、control／cleanup 用の別 counter |
| metadata | COW refs 上限、dead properties の node／user 累積上限、bulk 全体受付上限 |
| upload-only | 衝突時自動 rename、常に同形201 receipt、確定名・競合差の非開示、share 単位 reservation |
| ticket | 用途別 claim、個別 cancel、share expiry による期限 clamp、session 更新時に同一 budget を継承する規則 |
| 配信 | public content／page／entry route を含む ticket 会計の被覆 |
| ZIP | STORE 方針、manifest bytes、exact output size と実際の serializer の一致 |
| TicketDO | lease TTL、失敗時精算、更新、storage 上限、alarm／Cron repair |
| maintenance job | 1 invocation と job 全体の node／blob／API／時間予算 |
| preview／share | 保護共有の汎用 OG、認可済み response の明確な `no-store` |

`size×3` と1,024 requestsだけでは、**新 session 発行や別 content route から budget を迂回できないこと**を証明できません。

**確定案：** 全転送入口を同一の durable budget ID に接続し、上記累積上限を §13 の正本へ戻し、上限超過・更新・失効・切断の会計を固定する。

## G10 — search／Gallery SQL は仕様の完成形ではない【重大】

**該当：§3.1、§12、§15.1**

- bigram token を保存する列と、順序照合用 normalized text の区別がない。
- NFKC／casefold／かな統一、最終 substring 照合、MATCH 構文 escaping が消えている。
- external-content FTS の insert／update／delete 同期が未定義。
- search は scope subtree を件数で制限せず走査し、別 CTE の hits だけを10,000で制限する。
- Gallery CTE は candidate 50,000／10,000を強制していない。
- Gallery SQL に current blob／generator version 条件がない。
- PROPFIND は property 数で行が増幅する。1,000 child×多数 property の fixture が予算表にない。
- 「covering index」と記す index は、SELECT する `name/kind/revision/current_blob_id/updated_at` を全て含まない。

children keyset query と search query の構文・基本実行は SQLite で確認できました。したがって「SQL が全て実行不能」ではなく、**認可・世代・走査予算・検索意味論が未完成**という指摘です。D1 の実 `rows_read` は未測定です。

**確定案：** 検索原文と token 列を分離して transactional に FTS を同期し、scope の探索にも上限を設け、current blob・EffectiveLive を集合検査した SQL を規範 query とする。

## G11 — WebDAV の creator 修正は反映済みだが、周辺契約が後退【重大】

**該当：§7、§12.1、§13.2〜13.3**

creator 一致、MOVE 後の source lock 終了、strong collection ETag、DAV 同期上限403は改善されています。

一方、次が不足しています。

- DAV `If` の論理式評価と token submission の分離
- tagged／untagged／NOT／複数 list の意味と数値上限
- collection revision を増やすイベント
- `/dav/Shared/<stable-mount>` と予約名の規則
- PROPPATCH で先行成功した property を rollback した場合も含む応答
- dead property の namespace／mixed content 保存モデル
- numeric character reference 等を含む XML の受入範囲
- 未存在 URL の LOCK に必要な parent create operand
- protected live property 一覧
- Content-Length 欠落、If-Match 必須箇所の欠落エラー

標準5 entity 以外を一律拒否する規定は、DTD entity と正当な numeric character reference を区別していません。Class 1/2 を掲げるなら、制限として明示するだけでよいかも含めて判断が必要です。

**確定案：** DAV protocol profile を別の規範表にし、request／response fixture を対で固定して、各 method を共通 mutation／認可へ対応付ける。

---

# 2. ラウンド1〜4：採用済み重大指摘の全件照合

### 判定の意味

- **反映**：該当防御の設計規定を確認。実装・staging 合格を意味しない。
- **部分**：方向性はあるが、採用された条件・手順が不足。
- **矛盾**：規範記述同士が衝突、または掲載 SQL に反例がある。
- **代替反映**：後続ラウンドで明示的に変更され、安全側の代替が記載されている。
- 同一問題を再掲した P0／P1 も、対応表との追跡のため別途対応を示す。

## 2.1 ラウンド1 — Blocker 15件・Major 17件

| ID | v0.5 該当章 | 判定・残存事項 |
|---|---|---|
| B-01 | §3.3、§5.2、§6 | **部分／矛盾**。不変 blob は反映、原子的公開は不成立。G01 |
| B-02 | §0.1、§11.2〜11.3 | **部分／矛盾**。正本分離は反映、復旧 epoch／journal／GC 調停が不足。G03〜04 |
| B-03 | §3.1〜3.3、§5.2 | **部分**。root・名前一意性は反映、owner/blob 制約と原子的 tree CAS が不足。G01、G04 |
| B-04 | §6.2〜6.3 | **部分**。予約式はあるが、失敗物理課金・share reservation が未完成。G05、G09 |
| B-05 | §11.1 | **部分**。削除操作 ID はあるが、既削除子・chunk 排他・全 FK 順序が欠落。G04 |
| B-06 | §5.2、§7.3 | **部分**。space 単位は反映、permit の旧書込み排除が不足。G02 |
| B-07 | §6.2 | **部分**。state 表はあるが single／late part／complete-abort／orphan 回収が未完成。G05 |
| B-08 | §4、§5.1、§8 | **部分**。principal 分離は反映、全 operation と scope／operand の対応が不足。G02、G07 |
| B-09 | §2.2、§5.1、§14.3 | **反映**。public prefix、Bypass、未知 route 拒否の基本境界は一致 |
| B-10 | §5.1、§7.1、§10.4 | **部分／矛盾**。DAV 分離は反映、service／content の CSRF profile が衝突。G07 |
| B-11 | §0.3、§6.1、§13.2 | **部分**。主要サイズ値は反映、411・part size 別実効上限・single 経路不足。G05、G11 |
| B-12 | §10.3、§13.2、§18 | **代替反映**。Images 20,000,000B、v1 WASM 変換不採用 |
| B-13 | §8.3、§10.2、§13.2 | **部分**。non-ZIP64／entry 上限は反映、STORE・manifest／exact size 契約不足。G09 |
| B-14 | §5.3、§14.1〜14.2 | **部分**。`SUN` と lease 方針は反映、job／R2 副作用 fence・回収手順不足。G02〜04 |
| B-15 | §4.3、§14.1 | **部分・重大回帰**。初回許可 identity、signup、最後の admin 保護が欠落。G06 |
| M-01 | §3.4、§5.2、§12、§15.1 | **部分**。bind・primary・予算は反映、原子性と規範 query が未完成。G01、G10 |
| M-02 | §1、§3.2〜3.4、§7.1 | **部分**。KV 非権威は反映、path hint の generation／現在 path 再検証契約が不足 |
| M-03 | §0.3、§3.3、§7.3 | **部分**。ETag 分離は反映、collection revision 更新条件・復旧時 ABA が未確定。G03、G11 |
| M-04 | §3.3、§16・3.5 | **部分**。COW／cross-owner job は反映、folder COPY manifest・衝突・props 引継ぎ不足 |
| M-05 | §7 | **部分**。G11 |
| M-06 | §0.2〜0.3 | **反映**。通常 DAV と専用 multipart、Nextcloud 非目標を分離 |
| M-07 | §5.3、§9A.4、§10.3 | **部分**。outbox／世代 fence は反映、sent 回収・実行前 claim・client thumb 分離不足。G08〜09 |
| M-08 | §6.1、§6.3 | **部分**。IndexedDB／fingerprint は反映、再選択／handle と browser incremental hash の実装方式が欠落 |
| M-09 | §12.2 | **部分**。専用表は反映、正規化・token／原文・順序照合・FTS 同期不足。G10 |
| M-10 | §4.4、§14.1 | **部分**。random secret と人間 password の分離は反映、versioned KDF／鍵運用不足。G06 |
| M-11 | §3.1、§4.1〜4.3 | **部分**。iss+sub／JWT／service 分離は反映、email 自動結合禁止と失効運用の詳細不足。G06 |
| M-12 | §8、§10.4 | **部分**。version／internal share 非復活は反映、汎用 OG・no-store・session 更新不足。G09 |
| M-13 | §9A、§10 | **部分**。origin／sanitize 方針は反映、client thumb の node 権限境界が欠落。G08 |
| M-14 | §11、§13、§14.3 | **部分**。監視項目はあるが、保守 job の具体予算・回収契約不足。G09 |
| M-15 | §3.3、§7 | **部分**。portable name／sidecar は反映、Shared 予約名・stable mount ID が欠落。G11 |
| M-16 | §13.2、§13.4、§14.3、§18 | **部分**。保持・mask・監視は反映、鍵運用・費用 worksheet／運用手順は未完成。G06 |
| M-17 | §15.2〜15.3 | **部分**。failure gate はあるが、以前の13項目を完全に識別できる受入一覧ではなくなった |

R1 末尾の集約 P0／P1 は上記の再掲です。対応は次のとおりです。

- P0-1→B-01/B-07/M-03、P0-2→B-02、P0-3→B-08/B-15
- P0-4→B-03/B-04、P0-5→B-05、P0-6→B-06
- P1-1→B-11、P1-2→B-09/B-10、P1-3→B-14/M-14
- P1-4→B-12/B-13/M-07、P1-5→M-17

## 2.2 ラウンド2 — 個別指摘

重大指摘の取りこぼしを避けるため、対応表の D／A／W／C 全 ID を示します。

| ID | v0.5 該当章 | 判定・残存事項 |
|---|---|---|
| D-01 | §5.2 | **矛盾**。並行 PUT の安全性を支える batch 原子性が不成立。G01 |
| D-02 | §3.2、§5.2 | **部分**。tree CAS はあるが0行時の rollback がない。G01 |
| D-03 | §4.3、§5.2、§6.2 | **部分**。現在認可と commit の線形化がない。G02 |
| D-04 | §11.1 | **部分**。chunk と restore／purge の排他不足。G04 |
| D-05 | §3.1、§11.1 | **部分**。相互 FK は避けたが全削除 graph がない。G04 |
| D-06 | §11.2〜11.3 | **部分**。deleting の記述はあるが新参照拒否／R2 delete quiesce 不足。G04 |
| D-07 | §6.3 | **部分／矛盾**。失敗完成物の physical 計上が未定義。G05 |
| D-08 | §11.3、§13.2 | **部分**。35日は反映、backup5世代の最大年齢／pin と未接続。G03 |
| D-09 | §11.3、§14.2 | **矛盾**。復元 D1 の epoch+1 を正本へ逆同期。G03 |
| D-10 | §5.3、§10.3 | **未反映**。client thumb の node 単位分離がない。G08 |
| D-11 | §5.2 | **矛盾**。0行を SQL error にする安全性契約を失った。G01 |
| A-01 | §4.2、§5.1 | **部分**。tuple はあるが全 operation／non-node ID の schema・scope 対応不足。G07 |
| A-02 | §8.2、§9A.4 | **反映**。node＋blob、現在 subtree／EffectiveLive の基本規定あり |
| A-03 | §4.4、§8 | **部分**。共通 claim はあるが download／ZIP 等の用途別 schema 不足。G09 |
| A-04 | §8.1 | **部分**。読取り禁止はあるが、自動 rename・同形201・非開示応答が欠落。G09 |
| A-05 | §2.2、§5.1 | **反映**。未知 public route の private fallthrough 禁止 |
| A-06 | §8.2〜8.3、§13.2 | **部分**。予算値はあるが全配信経路・更新／取消しとの接続不足。G09 |
| W-01 | §7.3 | **代替反映**。R4 で creator 一致へ修正 |
| W-02 | §7.3 | **部分**。node 正準化は反映、shared mount の写像仕様が欠落。G11 |
| W-03 | §5.2、§7.3 | **部分**。permit はあるが期限回収後の旧 commit 排除不足。G02 |
| W-04 | §7.3 | **反映**。collection ETag に node identity を含む。復旧 epoch は別途 G03 |
| W-05 | §2.2、§7、§13.2 | **部分**。decode 等は反映、If の評価／提出分離と parser 上限不足。G11 |
| C-01 | §8.3、§10.2、§13.2 | **部分**。entry／形式上限は反映、STORE・manifest・exact size 不足。G09 |
| C-02 | §12.1、§13.2 | **部分**。node／PROPFIND 上限は反映、COW／props 等累積上限が欠落。G09 |
| C-03 | §8.2、§13.2 | **部分**。ticket 予算の経路被覆・更新時継承が未確定。G09 |
| C-04 | §6.2、§13.2 | **部分**。deadline／並列数は反映、attempt／累積 calls／bytes が欠落。G09 |
| C-05 | §5.3、§10.3、§13.2 | **部分**。fenced publish はあるが重処理前 claim と owner 全体予算不足。G09 |

### R2 状態機械指摘

| ID | v0.5 該当章 | 判定 |
|---|---|---|
| SM-01 | §6.2 | **部分**。create 後・upload ID 保存前 orphan の発見方法不足 |
| SM-02 | §6.2〜6.3 | **部分**。failed 終端はあるが未公開完成物の課金不足 |
| SM-03 | §6.2 | **部分**。in-flight 永続化は反映、旧 I/O と lease 期限の収束不足 |
| SM-04 | §6.2、§13.2 | **部分**。6日期限は反映、completing の deadline／lifecycle 競合が未完成 |
| SM-05 | §6.2 | **反映**。D1 terminal 優先。ただし `committed/completed` の呼称修正が必要 |
| SM-06 | §11.1 | **部分**。state 統一済み、chunk guard／既削除子不足 |
| SM-07 | §11.2 | **部分**。pin rows は反映、参照追加禁止と state 同期不足 |
| SM-08 | §5.3、§11.3 | **部分**。D1 fence と外部 R2 副作用の調停不足 |
| SM-09 | §5.3 | **部分**。consumer 先行対応は反映、sent message 消失後の回収契約不足 |
| SM-10 | §5.3、§10.3 | **部分**。派生物を namespace lock 対象外とする明示規定が欠落 |
| SM-11 | §11.3 | **部分／矛盾**。journal 形式不足、反映済み operation の failed 化。G03 |

### R2 必須修正 P0／P1 の再照合

| ID | 対応先・v0.5章 | 判定 |
|---|---|---|
| P0-01 | D-01/D-11、§5.2 | 矛盾 |
| P0-02 | D-02/D-03、§3.2・§5.2 | 部分 |
| P0-03 | D-04/D-05、§11.1 | 部分 |
| P0-04 | D-06/D-08、§11.2〜11.3 | 部分 |
| P0-05 | D-09、§11.3 | 矛盾 |
| P0-06 | SM-01〜05、§6.2 | 部分 |
| P0-07 | D-07、§6.3 | 部分／矛盾 |
| P0-08 | A-01〜03、§4.2・§8 | 部分 |
| P0-09 | W-01〜04、§5.2・§7.3 | creator／ETag は反映、fence は未完成 |
| P1-01 | D-10、§10.3 | 未反映 |
| P1-02 | C-01〜05、§6・§8・§13 | 部分 |
| P1-03 | SM-09/11、§5.3・§11.3 | 部分／矛盾 |
| P1-04 | CT-01〜05、§5.1・§6・§7 | public multipart／DAV Basic は反映、single・quota・実効 part 上限は不足 |

## 2.3 ラウンド3 — 原文で「重大」とされた全13件

| ID | v0.5 該当章 | 判定・残存事項 |
|---|---|---|
| A1 | §4.1 | **反映**。header-only、RS256、issuer／AUD、user/service claim 分離 |
| A3 | §4.1、§5.1 | **部分**。service principal は反映、automation upload が完結しない。G07 |
| A4 | §4.3、§8.2 | **部分**。毎 request 失効確認は反映、最大伝播表・owner share・content logout 不足。G06 |
| Z1 | §4.2、§5.1 | **部分**。全 scope／operation／フローの被覆は未完成。G07 |
| Z2 | §3.2、§12 | **部分**。EffectiveLive の規範は反映、一覧 SQL への一貫した組込みが未完成。G10 |
| Z3 | §4.2 | **反映**。terminal replay の同 principal／credential・現在開示権限を明記 |
| Z4 | §5.2、§11.3 | **部分／矛盾**。epoch guard はあるが復旧 epoch／旧 permit 排除に欠陥。G02〜03 |
| T1 | §4.4、§8.1 | **部分**。Cookie 属性は反映、share expiry clamp・session 管理詳細不足。G09 |
| T4 | §5.1、§8.2 | **部分／矛盾**。共通 CSRF と content cross-origin フローが衝突。G07 |
| C1 | §9A.2、§10.4 | **部分**。配信 matrix は反映、reader の資源解決・sandbox 内機能の実証未了 |
| W1 | §7.3 | **代替反映**。R4 で通常 mutation も creator 一致へ修正 |
| S1 | §4.3 | **部分・重大回帰**。identity 固定はあるが初回 allowlist／admin 保護が欠落。G06 |
| S3 | §8.1、§10.5、§13.4、§15 | **反映・staging gate**。fragment／POST、raw logging 禁止、全 log canary を規定 |

### R3 必須修正 P0／P1

この表で、重大以外の A2/A5、T2〜T3/T5〜T6、C2、I1〜I2、W2〜W3、S2/S4 も含む集約指摘を確認しています。

| ID | v0.5 該当章 | 判定 |
|---|---|---|
| P0-01 | §4.1 | **概ね反映**。JWKS の issuer 単位 single-flight／厳密 counter の配置は未定義 |
| P0-02 | §4.2、§5.1 | **部分**。G07 |
| P0-03 | §3.2、§12 | **部分**。規範は反映、query 実体との接続不足 |
| P0-04 | §4.3、§8.2 | **部分**。G06 |
| P0-05 | §4.4、§5.1、§8 | **部分**。用途別 token／session／CSRF lifecycle 不足 |
| P0-06 | §9A.2、§10.4 | **部分・browser gate**。安全側 fallback はあるが reader 契約未完成 |
| P0-07 | §8.1、§13.4、§15.2 | **反映・staging gate** |
| P0-08 | §0.3、§7.3 | **主要部分反映**。creator／MOVE／strong ETag は修正、validator 更新条件不足 |
| P0-09 | §4.3、§5.2、§11.3 | **部分／矛盾**。G02、G03、G06 |
| P1-01 | §3.3、§7.1、§10.5、§13.2 | **部分**。If／Timeout 等上限、JSON の重複 key 等が未定義 |
| P1-02 | §4.4、§13.4、§14.1 | **部分**。100k への変更は意図的代替だが versioned KDF／鍵 rotation が欠落 |
| P1-03 | §2.2、§14.1、§15.2 | **反映・staging gate**。ただし local bypass adapter の本番 bundle 非混入試験を具体化する |

## 2.4 ラウンド4 — P0 8件・P1 5件

R4 原文は各行に番号がないため、以下の番号は **§9 の掲載順に本レビューで付与**しています。

| ID | 原指摘／v0.5章 | 判定 |
|---|---|---|
| R4-P0-01 | 完全 migration／proof／barrier、§3.1・§5.2 | **未達／矛盾**。G01。全 migration も未掲載 |
| R4-P0-02 | commit 不明／補償／LockDO fence、§5.2・§7.3 | **部分**。結果不明の分類は改善、収束・旧 commit 排除は不足。G02 |
| R4-P0-03 | UploadDO 副作用遷移、§6.2〜6.3 | **部分**。表は追加されたが G05 が残る |
| R4-P0-04 | trash／restore／GC 境界、§11.1〜11.2 | **部分**。state 名・pin rows は修正、G04 が残る |
| R4-P0-05 | CONTENT_HOST／EPUB、§8.2・§9A.2 | **部分／矛盾**。Cookie／二重 iframe は採用、CORS／CSRF／reader 詳細未完成 |
| R4-P0-06 | WebDAV Class 2 方針、§7.3 | **反映**。creator 一致へ変更 |
| R4-P0-07 | KDF／WASM／fflate、§4.4・§6.1・§10.2・§13.5 | **代替反映・Phase 0 gate**。100k／DigestStream／sync fflate を明記 |
| R4-P0-08 | FTS backup／restore、§11.3 | **部分／矛盾**。通常 table export と FTS rebuild は反映、epoch／整合点が不成立。G03 |
| R4-P1-01 | 制限・error mapping、§13 | **部分**。主要単位は修正、累積上限の脱落・mapping 矛盾が残る |
| R4-P1-02 | 一覧 SQL／index／予算、§12・§15.1 | **部分**。G10 |
| R4-P1-03 | DO capacity／alarm／stale、§14.2 | **部分**。Lock／Upload／Control は表化、TicketDO と安全な期限回収不足 |
| R4-P1-04 | 完全 manifest／XML fixture、§5.1・§7.2 | **部分**。表と例は増えたがフロー完結性・規範 fixture が不足。G07、G11 |
| R4-P1-05 | phase 分割／依存、§16 | **部分**。30 deliverable は反映、quota／journal の導入時期と UI 完了条件が不足 |

### R4 対応表と本文の個別のずれ

P0／P1 集約とは別に、対応表の「採用」説明と本文が直接一致しない箇所です。

| R4 対応表の指摘 | 本文で確認できない／食い違う内容 |
|---|---|
| §1.3 upload budget | data／control／cleanup 別 counter がない |
| §1.3 archive index | index JSON 自体の byte 上限がない |
| §1.3 metadata capacity | COW refs／dead props 等の累積上限が脱落 |
| §2・Queue semantics | consumer の D1 確定後 ack を規範手順として固定していない |
| §4.1 完全制約 | owner/blob/root の整合制約が未完成 |
| §4.2 FTS 同期 | base table と FTS の insert/update/delete 同期がない |
| §7.2 grant/scope | enum は列挙したが全 operation への対応表がない |
| §7.3 same part | lease 後の late R2 write の無害化がない |
| §7.5 ticket 更新 | 同じ budget を保持する更新規則がない |
| §1.2 最終 part | 対応表は0B可、本文 §13.2 は `>0`。0B file は single PUT へ限定する本文側に統一すべき |

一方、WASM 画像変換・scrypt・hash-wasm・fflate Async の不採用、KDF 100k 化、DAV creator 一致への変更は、**意図的変更として確認済みであり回帰扱いしていません**。

---

# 3. 章をまたぐ一貫性の問題

主要な安全性問題と重複するものも、実装者が遭遇する名前・API・数値の観点で整理します。

| 分類 | 矛盾・曖昧さ | 該当章 | 統一案 |
|---|---|---|---|
| epoch | ControlDO 正本なのに復元 D1 の `+1` を逆同期 | §0.1／§11.3／§14.2 | ControlDO 発行値を D1 に複製 |
| operation state | `committed` 不変と、backup 後 operation を `failed` 化が衝突 | §5.2／§11.3 | commit 済み結果と再実行禁止を別属性にする |
| upload state | D1 uploads は `completed`、説明は「D1 committed」 | §6.2 | `operations.committed` と `uploads.completed` を明記 |
| operation 名 | `node.restore` と `trash.restore` が混在 | §4.2／§5.1 | 単一 enum に統一 |
| scope | `state.write`、`credential.*`、`trash.*` 等と scope enum の対応がない | §4.2／§5.1 | operation→scope→operand の完全表 |
| principal | `job(saved_principal,...)` と service/user の credential 継続条件が不明 | §4.1／§5.3 | actor、credential、grant、実行 fence を別フィールドにする |
| schema | `control` の CREATE／INSERT が二か所に重複 | §3.1／§5.2 | DDL は一か所を正本、他は参照 |
| index | children 用 index が同一列・同一 predicate で重複 | §3.1／§12.1 | 一つの index 名に統一 |
| media 列 | `duration` と query の `duration_ms`、`dominant color` の表記が未固定 | §9A.1／§12.3 | migration の列辞書を正本化 |
| ref count | current/version/pin を数える一方、pin は別 table でも検査 | §3.3／§11.2 | count の定義・増減イベント・再計算式を明記 |
| node guard | 全 node step に `deleted_at IS NULL` を要求するが restore/purge は削除済み node を扱う | §5.2／§11.1 | operation 別状態述語に分離 |
| derivative | 不変 key と固定 client thumb key 上書きが衝突 | §3.3／§10.3 | node-bound immutable attempt key |
| API | automation upload の後続 route がない | §4.1／§5.1 | service フローを完結させるか v1 非提供 |
| CORS/CSRF | content cross-origin fetch と same-origin-only mutation が衝突 | §5.1／§8.2 | route 別 CSRF profile＋preflight |
| host 用語 | `CONTENT_HOST` と config の `CONTENT_ORIGIN` が混在 | §8.2／§14.1 | 設定名は origin に統一し scheme/port を含め比較 |
| ETag | file の XML fixture が node-revision 形式、content ETag との関係不明 | §3.3／§7.2〜7.3 | file/DAV/metadata/collection の validator 表 |
| cache | `private cache` だけでは no-store にならない | §9／§10.4 | 認可済み API／content の Cache-Control を明記 |
| R2 absent | 一律404と、committed blob 欠損時 repair503 | §10.1／§13.3 | 未存在 resource と整合性障害を分ける |
| runtime error | CPU/memory 1102 を Worker が常に503へ変換できるように読める | §13.3 | catch 可能な例外と platform 終了を区別 |
| token size | token≤2KiB と bounded target 集合の最大件数が未接続 | §8.2／§13.2 | token は集合 ID＋hash、集合本体は durable storage |
| ZIP 境界 | `UINT32_MAX未満` と `4GiB未満` は1 byte差 | §10.2／§13.2 | exact byte 定数を一つにする |
| retention | backup5世代と、旧採用方針の5日が同値でない | §11.3／§13.2 | 最大年齢と世代数を別々に定義 |
| phase | transfer／overwrite が quota reservation 基盤より先 | §16・2.x／3.1 | quota ledger を Foundation に前倒し |
| phase | mutation を実装した後で journal を導入 | §16・1.5〜4.3 | journal は最初の mutation と同時に導入 |

---

# 4. 完全性：実装が止まる箇所と確定案

以下は、実装順に並べた**設計承認用の提案**です。v0.5 に既に書かれていると解釈してはいけません。

| フェーズ | 手が止まる箇所 | 一文の確定案 |
|---|---|---|
| 0 | runtime／toolchain／依存版 | Node・pnpm・Wrangler・TypeScript・Vitest・各依存を互換性確認済み exact version で固定し、採用時点で公開7日未満の版は使わない。 |
| 0 | SQL rollback と commit 不明 | SQL 内の失敗 assertion を原子性の条件とし、応答喪失は durable operation の照合へ移して失敗補償と分離する。 |
| 1 | 全 schema・enum・状態 | table/column/FK/index、operation/scope/error、状態遷移を一つの機械可読 contract に固定する。 |
| 1 | bootstrap・新規 user 登録 | 明示 identity allowlist だけが bootstrap でき、signup は既定無効、最後の app_admin の停止・削除を禁止する。 |
| 1 | Idempotency-Key の意味 | principal/credential/space/kind と canonical request digest に束縛し、同一 key 別 payload は409、同一 intent の再送は同じ operation を照合する。 |
| 1 | quota・refs・journal | 最初の create から reservation、logical/physical ledger、version/ref/pin、audit/outbox/journal を同一 commit 契約に組み込む。 |
| 1 | key rotation | 用途別 key ring と record ごとの kid/KDF parameters を保存し、通常更新・緊急失効・app password 再発行を別手順にする。 |
| 2 | create／overwrite／rename | request/response schema、必須 revision/If-Match、衝突方針、parent revision 更新、content ETag を operation ごとに固定する。 |
| 2 | COPY／MOVE | cross-space MOVE は拒否し、folder COPY は固定 manifest・衝突方針・props 引継ぎ・部分結果を定義する。 |
| 3 | single upload body | `PUT /api/v1/uploads/:uploadId/content` と対応 public route を追加し、single body をその request 内で staging R2 へ保存する。 |
| 3 | small/zero-byte public upload | single mode も application upload ID と capability を持ち、multipart API を呼ばず同じ complete／cleanup 契約に従わせる。 |
| 3 | unknown R2 attempt | 未確定の旧 I/O が残る upload は新 attempt と並走させず、必要なら upload 全体を安全に中止して別 R2 upload ID で再開する。 |
| 4 | trash membership／FK | 既削除子を区別する membership と FK 削除表を固定し、restore/purge の全 chunk を state＋fence で条件付ける。 |
| 4 | backup／restore | commit sequence と全通常 table の journal を正本にし、ControlDO 発行の新 epoch、GC delete quiesce、FTS rebuild、再計算で復旧を検証する。 |
| 5 | search／cursor／stats | normalization と bigram encoding を版固定し、cursor を scope/filter/sort に束縛して、不完全検索と遅延統計を明示する。 |
| 6 | share／ticket／CSRF | link/internal/upload-only の action 表、one-time CSRF 発行、ticket 発行数、更新・取消し・budget 継承を確定する。 |
| 6 | content session／複数 tab | Cookie は durable session ID を指し、target 集合の更新と ticket budget を維持し、別 tab の session 発行で既存再生を不用意に失効させない。 |
| 6 | ZIP 配信 | ZIP 作成 API が返す manifest/ticket と配信 endpoint を固定し、全 entry の認可・pin・exact size を配信前に検査する。 |
| 7 | DAV | 認証 username、If/Depth/Timeout/Overwrite、properties、mount、ETag、全 status を規範 fixture に固定する。 |
| 8 | archive／EPUB | entry token は bearer にせず index 内 entry 識別子とし、内部 URL 書換え・sanitize・CSS/font・CFI・postMessage を固定する。 |
| 8 | metadata override／読書・再生位置 | 抽出値と user override を分離し、位置 state を user/node/blob に束縛して content 更新時の扱いを決める。 |
| 横断 | UI の完了条件 | Gallery／Bookshelf／Audio を API 名だけで完了扱いせず、追加要求の表示・操作・保存状態を E2E 受入項目へ戻す。 |
| release | Cloudflare 運用設定 | Access policy、resource inventory、R2 lifecycle、Queue retention/DLQ、秘密鍵、監視、restore 手順を environment 別に管理する。 |

---

# 5. 過剰設計の検出と削減案

**認可・データ整合性・復旧の仕組みは削減対象にしません。** 以下は機能・実装方式の簡素化候補です。

| 対象 | 削減案 | 残すもの |
|---|---|---|
| PWA | v1 は Service Worker なしでもよい | logout 時の browser state 消去、通常 SPA |
| EPUB 高度組版 | 正確な印刷風 pagination・複雑な CFI 互換は独立 gate とし、未合格なら承認の上でスクロール中心に縮小 | EPUB の安全な閲覧、TOC、読書位置、script 禁止 |
| media UI の同時投入 | timeline scrubber、複数レイアウト、高度な player 操作を後段へ分離 | Gallery／Bookshelf／Audio の基本利用、Range、状態保存 |
| 表示用 folder_stats | v1 は明示的な遅延集計または要求時の bounded 集計に限定 | quota の正確な台帳は別系統で維持 |
| service automation | 完結する最小 operation だけ提供し、不完全な upload create は公開しない | service/user の認証分離と scope 検査 |
| client thumbnail | best-effort が不要な初期版では受付自体を無効化できる | 有効化するなら node 単位分離・再encode・世代 CAS 必須 |
| 重複 index | children の同一定義 index を一つにする | keyset 性能・認可用 index |
| public bundle 分離 | server／private chunk の流入は禁止しつつ、純粋な表示部品の source 再利用まで禁止しない | 配信 manifest と auth 境界、SRI |

削減は仕様変更として承認を取るべきであり、**Gallery・Bookshelf・Audio 自体を実装者判断で v1 から落としてはいけません**。

---

# 6. `docs/IMPLEMENTATION_BRIEF.md` 草案

> **以下は未作成のファイルに入れるための草案です。**  
> G01〜G11 の是正案が承認されるまでは、矛盾する v0.5 の代わりとして勝手に採用せず、Phase 0 の再現・検証に限定してください。

---

## Next-cloud-flare — Implementation Brief for Sol

### 0. 作業開始条件

状態：**BLOCKED — R5 最終ゲート未通過**

- R5 の原子性、permit fence、復旧 epoch、upload／quota、trash／GC、bootstrap の修正契約が承認されるまで本番機能を実装しない。
- 設計の安全性に関わる空欄を、実装者の推測で埋めない。
- Phase 0 の isolated spike と failing regression test は先行可能。
- 各フェーズの完了は、そのフェーズの不変条件と既存回帰で判定する。
- `M/U/I/R` は migration／unit／integration／rollback・復旧手順を意味する。

### 1. 絶対に守る不変条件10か条

1. **正本を混同しない。**  
   D1 は namespace／認可／台帳、R2 は不変 content、ControlDO は復旧外の単調増加 epoch／maintenance／GC pause の正本とする。

2. **失敗した mutation は部分確定させない。**  
   node、tree、version/ref、quota、audit、outbox、journal の必須変更は同一 D1 transaction で成立し、必須条件不成立は SQL error で rollback する。

3. **旧実行を確定させない。**  
   epoch／permit／job claim fence を commit 側で強制し、期限切れ・reset・lease 奪取後の旧 Worker を無害化する。

4. **全 operand を現在の権限で認可する。**  
   source、destination、親、置換先、share/upload/job/operation ID、credential scope を検査し、owner/admin 例外で制限 credential を拡張しない。

5. **読取りにも EffectiveLive を適用する。**  
   HEAD、Range、304、thumb、search/count、ZIP、media、ticket を含め space root まで検証し、共有外の ancestor 名を返さない。

6. **tree を壊さない。**  
   root 一意、owner/space/parent 整合、portable name 一意、cycle 禁止、子孫を含む depth 上限、構造変更 CAS を守る。

7. **容量と参照は一度だけ会計する。**  
   reservation、logical、physical、current/version/pin の定義を固定し、失敗 upload／orphan／GC 待ちを未課金にせず、物理削除確認前に physical を減らさない。

8. **転送と job は耐久状態機械で管理する。**  
   受付停止、in-flight、attempt、deadline、cleanup を永続化し、外部 I/O の応答喪失を未実行と扱わず、R2 完成だけで成功を返さない。

9. **削除と復旧を競合させない。**  
   既削除子を勝手に復活させず、restore は最後に公開し、deleting blob への参照を拒否し、GC quiesce と復旧検証前にサービスを再開しない。

10. **未信頼入力と秘密情報を境界外へ出さない。**  
    bounded parser／stream／費用上限、用途別 token、safe MIME/CSP、public/private asset 分離、client thumb の node 境界、secret 非記録を全経路で守る。

### 2. 実装順序・完了条件・テスト

以下のパスは**作成予定の成果物名**であり、現リポジトリに存在することを意味しない。

略記：

```text
W = packages/worker
B = packages/web
S = packages/shared
```

| Phase | 実装内容・順序 | 完了条件と必須テスト | 作成する主なファイル／パッケージ |
|---|---|---|---|
| **0：成立性検証** | toolchain、binding、D1 assertion、R2 known-length stream、DigestStream、Range、fflate sync、KDF/Images | 0行失敗で副作用ゼロ、SQL error rollback、commit 応答喪失分類、slow consumer／cancel、100k受理、Images境界を検証 | root `package.json`、`pnpm-workspace.yaml`、lockfile、`tsconfig`、`wrangler.jsonc`、W/B/S の package manifest、`W/test/fixtures/`、spike tests |
| **1：Foundation** | complete contract→schema→primary adapter→ControlDO→auth/authorize→quota/ref/pin/journal→LockDO→一つの create＋outbox | FK/CHECK、bind100、bootstrap 競合、全 principal negative matrix、深さ64、claim 競合、permit expiry/reset、失効対commit、old epoch、outbox duplicate を合格 | `W/migrations/*.sql`、`W/src/db/`、`W/src/routes/manifest.ts`、`W/src/auth/`、`W/src/do/{ControlDO,LockDO}.ts`、`W/src/services/{fsMutation,quota,refs,journal}.ts`、`W/src/jobs/{outbox,claims,repair}.ts`、`S/src/{contracts,limits,errors}.ts` |
| **2：Files core** | immutable transfer/read→create→overwrite/version→rename/MOVE→same-owner COW | 同名／並行 PUT／相互 MOVE、R2成功D1失敗、D1成功応答喪失、全 Range/HEAD/ETag、COW quota/ref、lock 対REST、folder COPY fixture を合格 | `W/src/services/{nodes,blobs,versions,copy,content}.ts`、`W/src/api/nodes.ts`、`B/src/features/files/`、関連 migration・unit/integration tests |
| **3：Upload／copy job** | single→multipart create→part/status/resume→complete→abort/expire→cross-owner copy | 0B、小ファイル、虚偽size、欠落part、同part retry、late旧attempt、reset、complete/abort/expiry競合、予約保持、orphan cleanup、全累積予算を合格 | `W/src/do/UploadDO.ts`、`W/src/services/uploads/`、`W/src/api/uploads.ts`、`W/src/jobs/copy.ts`、`B/src/features/uploads/`、`B/src/workers/fileHash.worker.ts` |
| **4：Trash／GC／recovery** | trash membership→restore→purge→GC→logical backup→restore drill | 独立削除子、tag途中restore、purge競合、全FK、複数pin、参照追加対deleting、delete応答喪失、Time Travel／backup復旧、epoch非再使用、quota/ref再計算を合格 | `W/src/services/{trash,pins,gc}.ts`、`W/src/jobs/{trash,purge,gc,backup,restore}.ts`、`W/src/backup/`、`B/src/features/trash/`、`scripts/restore-drill.*` |
| **5：List／search／stats** | keyset一覧→FTS同期→scope-aware search→bounded stats | 正規化、日本語順序照合、MATCH injection、1文字検索、旧索引、無権限候補、候補上限、cursor改変、§15.1実D1予算を合格 | `W/src/services/{listing,search,stats}.ts`、`W/src/search/`、FTS migration、`B/src/features/search/` |
| **6：Share／content／ZIP** | shareモデル→CSRF/session→internal mount→upload-only→content TicketDO→public bundle→ZIP | 匿名E2E、衝突名oracle無し、share失効、祖先trash、session更新でbudget増えない、複数tab、preflight/Cookie、token用途混同、ZIP exact size/pin/cancel を合格 | `W/src/do/TicketDO.ts`、`W/src/auth/{share,csrf,tokens}.ts`、`W/src/api/{shares,public,contentSession}.ts`、`W/src/services/{tickets,zip}.ts`、`B/src/public-share/`、独立 public build manifest |
| **7：WebDAV** | Class1→props/XML→条件header→Class2→COPY/MOVE→実client | XML request/response fixtures、If式、creator、alias、MOVE後lock、lock-null、Depth、Overwrite、PROPPATCH全rollback、403大規模拒否、litmus／rclone／Finder／Explorer を合格 | `W/src/dav/{router,path,davXml,properties,conditions,methods}.ts`、`W/test/fixtures/dav/`、DAV integration tests |
| **8A：Gallery** | metadata／Images→generation result→Gallery API→UI | EXIF GPS非保存、current blob guard、COW thumb分離、変換前claim、retry費用、50k候補gate、共有Gallery を合格 | `W/src/media/images/`、`W/src/jobs/media.ts`、media migration、`B/src/features/gallery/` |
| **8B：Bookshelf** | ZIP index→page stream→PDF→EPUB sanitize→trusted reader→読書状態 | zip bomb／CRC／overflow／暗号化、危険path、CSS/URL sanitize、sandbox、CFI/state更新、公開共有、browser差 を合格 | `W/src/media/{archive,epub}/`、`W/src/jobs/sanitize.ts`、library migration、`B/src/reader/`、`B/src/features/library/`、pdf.js worker/CMap assets |
| **8C：Audio** | bounded tag／cover→tracks→override→player／状態 | head/tail/moov/cover上限、未対応codec、Range seek、session更新、SPA遷移中再生、user別position、共有再生 を合格 | `W/src/media/audio/`、audio migration、`B/src/features/audio/`、`B/src/player/` |
| **9：Release** | UI横断品質→監視→運用演習→support matrix→承認配備 | a11y／touch／低性能端末、upload離脱、logout全cache、全failure regression、log canary、費用/capacity、backup復旧、rollback rehearsal の証跡を揃える | CI workflows、`scripts/{verify-config,staging-smoke,release-gate}.*`、監視設定、運用用 approved scripts |

**依存上の注意：**

- quota、ref/pin、journal は Phase 1。Phase 3／4 で後付けしない。
- Phase 4 の shared subtree 試験は fixture grant で先行し、Phase 6 で実 HTTP 経路を追加する。
- control／repair／outbox は最終 polish ではなく Foundation。
- schema の変更は migration と fixture を同時に変更する。
- phase ごとの rollback は「何でも down migration」ではなく、前版へ戻せる範囲と maintenance／restore が必要な範囲を区別する。

### 3. 依存パッケージの方針

設計で採用済みの候補：

- Worker：`hono`、`@hono/zod-openapi`、互換する `zod`
- DAV：`fast-xml-parser`。adapter 外から直接使用しない
- ZIP 生成：`fflate` の同期 streaming API のみ
- Web：React、Vite、Tailwind、shadcn/ui、TanStack Router/Query/Virtual
- PDF：`pdfjs-dist`、browser のみ
- Test：Vitest、`@cloudflare/vitest-pool-workers`、browser E2E runner

未確定の JWT verifier、sanitizer、browser incremental hash 等は、**機能・runtime・保守状況を評価して採用版を承認してから追加**する。自作暗号や巨大な独自 sanitizer を暗黙に導入しない。

### 4. ローカル開発構成

- pnpm workspace：worker／web／shared。
- Worker の `fetch/queue/scheduled` と DO を local runtime で動かす。
- private SPA、public-share、reader を別 entry として build し、Worker が manifest に従って assets を配信する。
- local D1/R2/KV/DO/Queues の state は staging／production と分離。
- Cookie／CORS の local 試験は、app/content の別 origin と HTTPS を使う。
- local auth fixture adapter は開発・test 専用 entry に限定し、本番 bundle へ含めない。
- secret はローカルの未追跡設定または環境別 secret store から供給し、Git・frontend・test snapshot へ含めない。
- 本番相当の Access、zone body limit、Images codec、Queue concurrency、D1 性能は local 成功で代替しない。

**用意する package scripts の案：**

```text
pnpm dev
pnpm lint
pnpm typecheck
pnpm build
pnpm test:unit
pnpm test:integration
pnpm test:e2e
pnpm verify:contracts
pnpm verify:config
```

これらは実装時に定義するコマンドであり、現在存在するコマンドではない。

### 5. CI 構成

#### A. 通常 PR CI — cloud 資格情報なし

1. frozen lockfile install
2. lint／typecheck／build
3. manifest、scope、error、limit、schema の整合検査
4. unit tests
5. Workers integration tests
6. D1 migration／FK／FTS／rollback／失敗注入
7. DO reset／alarm／duplicate delivery／stream backpressure
8. public bundle に private chunk・secret・開発 bypass がないことを検査

#### B. 承認付き staging CI

- environment 専用 resource へ配備。
- Access policy、Service Auth、Bypass、host/alias、HTTPS を実 HTTP 検査。
- content Cookie／CORS／preflight、KDF、Images、R2、Queue を実検査。
- D1 query 数・rows_read・duration、DO 負荷・alarm 枯渇を計測。
- lifecycle、Queue retention／DLQ、resource inventory の drift を検査。
- secret canary と restore drill を実施。

#### C. Release gate

- Finder／Explorer／rclone／cadaver の support matrix。
- browser 別の reader、Cookie、Range、media の試験。
- R1〜R5 の failure regression 一覧を全件消化。
- backup generation の復元証跡、RPO/RTO 実測。
- 料金・容量 worksheet と監視閾値。
- production 配備は承認付き。PR CI から自動配備しない。

### 6. 迷ったときの判断原則

1. **安全性の矛盾は止めて報告する。** 後の章だから、対応表が「採用」だから、という理由で危険な規定を選ばない。
2. **実装可能性が未確認なら機能を閉じる。** 認可・quota・復旧の検査を緩めて動かさない。
3. **commit 不明は失敗ではない。** 状態を照合し、同一 operation ID で再開する。
4. **SQL／型／テストの役割を混同しない。** 型安全だけで認可や transaction を保証したとしない。
5. **元データを優先する。** preview／検索／集計が失敗しても内容・参照・復旧可能性を壊さない。
6. **上限未達はアルゴリズム改善か機能縮小で対処する。** platform 制限や security control を緩和しない。
7. **テスト成功範囲を明記する。** SQLite、Miniflare、staging、実 client を区別する。

### 7. 禁止事項

- 同一 content key の上書き、論理 path を R2 key にすること。
- D1 commit 後の JS 例外を rollback とみなすこと。
- operation の状態だけを failed にして部分更新を「補償済み」と扱うこと。
- 認可、失効、mutex、厳密 quota を KV／PoP-local rate limit に依存させること。
- long upload／D1 I/O を `blockConcurrencyWhile()` で囲むこと。
- in-flight や lease を memory counter／`finally`／shutdown hook だけで管理すること。
- 大容量 body の全メモリ化、無制限 `Promise.all`、backpressure のない `tee()`。
- `fflate Async*`、Worker の通常 runtime での hash-wasm loader、自動 WASM image fallback。
- public route から private router／SPA／assets への fallthrough。
- bearer secret を URL、operation result、journal、log、trace に保存すること。
- app_admin に他者 content read を暗黙付与すること。
- client thumbnail を blob 共通 result として公開すること。
- FK 無効化、quota／認可 check の一時撤去で試験を通すこと。
- 未承認の production migration、purge、GC、restore、資源削除。
- 未合格の機能を「一応動く」として v1 support matrix に載せること。

---

# 7. 最終ゲートの通過条件

判定を変更するには、少なくとも次を満たしてください。

1. **原子性の是正**  
   G01 の3反例と、全必須 step の0行／constraint failure で副作用ゼロを確認する。

2. **fence／認可の線形化**  
   claim 前停止、claimed 放置、permit expiry、DO reset、失効対commit、旧 HTTP 再開を安全に収束させる。

3. **復旧契約の修正**  
   ControlDO epoch の非再使用、snapshot と terminal result の一致、全 journal、GC delete quiesce を定義する。

4. **upload／quota／trash／GC の完成**  
   single/public small file、失敗物理課金、late part、既削除子、全 FK、deleting への新参照拒否を仕様化する。

5. **認証・API のフロー完成**  
   bootstrap allowlist、鍵 rotation、失効表、content preflight/CSRF、automation upload、ticket/ZIP、client thumb 分離を確定する。

6. **回帰台帳を本文へ反映**  
   このレビューで「部分／矛盾／未反映」とした項目を、採用・明示的代替・安全な機能縮小のいずれかで解決し、各項目に実行可能な受入試験を対応付ける。

**結論：現時点は No-Go。**  
Cloudflare 上で実現できない設計ではありません。しかし、現状のまま渡すと Sol は「不足分の実装」ではなく、**原子性・認可・復旧の再設計**を実装中に行うことになります。まずその判断を設計側で確定し、その後に上記 brief に従って段階実装へ移るのが適切です。
