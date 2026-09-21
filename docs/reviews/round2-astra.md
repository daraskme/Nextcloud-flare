設計本文とラウンド1の指摘・反映表を照合し、競合操作と認可境界を具体的な手順で検証します。ファイルは編集しません。Cloudflare の仕様に依存する箇所は、確認できた事項と「要確認」を区別します。本文の主要な変更は反映されていますが、まだ「事前検査」と「D1 確定／R2 削除」の間に競合が入る余地があります。特に、GC と参照追加、祖先 MOVE と認可、共有コピーのサムネイル、`completing` からの失敗回復を重点的に検証しています。WebDAV の明示規定で防げる攻撃は、残存問題と分けて評価します。記載された外部キーを SQLite のインメモリ最小例で再現すると、`trash_ops` と `nodes` が相互参照するため、そのままの順序では purge が停止します。また、別々の子孫を移動先にする相互 MOVE は、双方の事前検査と source revision の CAS を通過して循環を作れました。

通常 ZIP も「非圧縮総量 4 GiB 未満」だけでは不十分です。ヘッダ分で32bitオフセットを超える反例に加え、65,000件の R2 読み出しは設計記載の既定10,000サブリクエストを超えます。これらの具体的な反例と、実装契約が未定義の項目を分けて最終判定をまとめます。# ラウンド2 敵対的レビュー — v0.2

## 結論：**No — 現状のまま本実装の契約には渡せない**

ラウンド1から、不変 blob、quota 予約、principal 分離、公開ルート境界などは明確に改善されています。

残る中心問題は、**「検査する」という規定と、「その検査結果が確定まで有効であることを保証するプロトコル」が一致していない**点です。特に以下は実装前の修正が必要です。

- 祖先関係が変わる並行 MOVE と、認可・削除状態の検査。
- restore・purge・子孫処理間の排他と状態遷移。
- GC の不可逆な削除決定と、R2 に適用できない fencing。
- `trash_ops` を含む purge の外部キー処理。
- UploadDO の失敗終端と、失敗 blob の容量計上。
- ticket の用途・対象 node・現在の capability との対応。
- WebDAV のロック所有者・共有 mount の別名・URI 再利用時の ETag。
- ZIP と、metadata／公開配信の費用上限。

### 判定の読み方

- **反例あり**：記載されたスキーマ・数値・手順に具体的な反例がある。
- **契約不足**：安全な実装は可能だが、本文の規定だけでは危険な実装を排除できない。
- **防御規定あり**：本文どおり実装すれば、示した経路は防げる。

実装コードの脆弱性を確認した、という意味ではありません。外部キーと並行 MOVE は **SQLite のインメモリ最小例**で確認しました。D1 実環境での試験は実施していません。ファイルは編集していません。

---

# 1. データ破壊・不整合

## D-01：同一 revision への並行 PUT

**低／受容可 — 防御規定あり。ただし D-11 の batch 契約が前提**

**根拠：** §3.4、§3.5、§5.2。

- **前提状態：** `nodes F` は revision 7、current blob は B0。
- **操作列：**
  1. PUT-A、PUT-B がともに revision 7 を期待して開始する。
  2. A は BA、B は BB という異なる R2 key に書く。
  3. A が D1 CAS に成功し、F を revision 8／BA にする。
  4. B の `WHERE revision=7` は0行になる。
- **結果：** B が BA を上書きすることはない。旧 B0 も内部世代として保持される。
- **防ぐ規定：** 不変 key、期待 revision、0行時の未公開 blob 回収、従属更新の guard。

応答喪失後に同じ operation の結果として revision 8 を返すこと自体は、DB の revision 巻き戻りではありません。再試行で再度 mutation しないことが重要です。

---

## D-02：直接の親・source revision を確認しても、相互 MOVE で循環する

**致命／実装前に直すべき — 契約不足、最小反例確認済み**

**根拠：** §3.2 の循環禁止、§5.2 の「手順1で tree 条件検査」「手順5で期待 revision 付き確定」。

次の初期ツリーを考えます。

```text
root
├─ P
│  └─ A
│     └─ a
└─ Q
   └─ B
      └─ b
```

- **前提状態：** 各 node は未削除で同一 owner。
- **操作列：**
  1. M1 が「A を b の下へ移動」を事前検査する。b は A の子孫ではない。
  2. M2 が「B を a の下へ移動」を事前検査する。a は B の子孫ではない。
  3. M1 が A、旧親 P、新親 b の revision を更新して確定する。
  4. M2 が B、旧親 Q、新親 a の revision を更新して確定する。
- **結果：**

```text
A → parent b → parent B → parent a → parent A
```

両操作の直接の更新対象は別なので、source・直接の親の CAS を持っていても通過できます。名前一意性・通常の外部キーも循環を防ぎません。

- **防げない点：** `space_generation` は §3.5／§7.1 では cache・再検証用であり、tree mutation の commit 条件としての更新・CAS が定義されていません。
- **必須修正：** 循環・深さ・祖先状態を D1 の確定処理内で検証するか、tree generation／競合する subtree の変更を確定まで直列化する契約が必要です。

`LockDO` の operation 予約が実際には commit までの十分な排他を提供するなら防げます。しかし、予約の競合集合・寿命・解放条件が本文にありません。「DO は単一スレッド」だけでは代替できません。

[DESIGN.md:376-388](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

---

## D-03：complete の認可後に、共有失効・祖先 MOVE・祖先 DELETE が入る

**重大／実装前に直すべき — 契約不足**

**根拠：** §4.3、§5.2、§6.3、§11.1。

- **前提状態：** 編集共有 root R の配下に `R/D/F` がある。F の upload が完了可能。
- **操作列：**
  1. complete が primary で共有・祖先・F の revision を検査する。
  2. owner が共有を revoke、または D を共有外へ MOVE、または R を trash にする。
  3. complete が F の `revision`／`deleted_at` だけを条件に D1 確定する。
- **結果：**
  - revoke は F の revision を変更しない。
  - 祖先 D の MOVE も F の revision を変更しない。
  - 大規模 trash では、F の `deleted_at` がまだ未設定の場合がある。
  - したがって、失効後・共有外・論理削除済み subtree に書き込みが確定し得る。
- **既存防御：** complete 時の再認可は、**再認可より前に**失効したケースを防ぐ。
- **不足：** 再認可から commit までの失効・祖先変更を排除しない。

**必須修正：** 認可の線形化点を決め、share version、credential の失効状態、祖先の有効性／tree generation を commit guard に含めること。「認可済みの処理は取消後も完了可」とするなら、それを明示し、長時間 upload にまで適用するかを別に決める必要があります。

---

## D-04：trash の子孫処理・restore・purge が互いに追い越す

**致命／実装前に直すべき — 契約不足**

**根拠：** §11.1、`trash_ops.state`、`nodes.deleted_op_id`、固定 purge manifest。

### 経路A：restore 後に古い delete job が子を再削除

- **前提状態：** A の大量削除 T が root を不可視化し、子孫へのタグ付けは途中。
- **操作列：**
  1. restore が現時点で `deleted_op_id=T` の node を復元する。
  2. A が再び見える。
  3. 古い delete job が checkpoint から再開し、まだ未処理だった子 C に T を設定する。
- **結果：** 復元したフォルダの一部が後から消える。子の share 無効化も遅延すれば、共有の復活方針と矛盾する。
- **不足：** restore を許す trash 状態、旧 chunk を無効化する世代条件がない。

### 経路B：restore 成功後に固定 manifest の purge が削除

- **前提状態：** purge が A の manifest を固定したが、全 node はまだ残っている。
- **操作列：**
  1. restore が `deleted_op_id` を解除して A／子を公開する。
  2. purge が固定 manifest を続行する。
  3. `node_versions` と current blob 参照を除去し、node を削除する。
- **結果：** 利用者には復元成功が返ったのに、復元済みデータが消える。
- **不足：** 「manifest 固定」は対象集合の安定化であって、restore との排他ではない。

**必須修正：** 少なくとも `trashing → trashed → restoring|purging → restored|purged` の相互排他、各 chunk の operation generation guard、`purging` からの restore 禁止／取消確定手順が必要です。

---

## D-05：purge は `shares` を消しても外部キーで止まる

**重大／実装前に直すべき — 反例あり**

**根拠：** §3.1、§11.1。

次の参照が残っています。

```text
trash_ops.root_node_id → nodes.id
nodes.deleted_op_id   → trash_ops.id
uploads.parent_id     → nodes.id
nodes.parent_id       → nodes.id
```

- **前提状態：** node N を trash operation T で削除済み。
- **操作列：**
  1. §11.1 の順序で share、props、thumb、versions、blob 参照を処理する。
  2. N を DELETE する。
- **結果：** `trash_ops.root_node_id=N` により外部キー違反。
- **単純な順序変更も不可：** 先に T を DELETE すると、今度は `nodes.deleted_op_id=T` により違反する。最小 SQLite 例でも両方を確認しました。

さらに：

- terminal upload を保存し続けると、その `uploads.parent_id` が folder purge を妨げる。
- 以前に別操作で削除した子を親の purge manifest に含めない場合、その子の `parent_id` が親削除を妨げる。

R2 より先に D1 を処理する変更は正しく、ここではまず **安全側の停止**になります。しかし、purge が永久 pending になり容量を回収できません。

**必須修正：** trash ledger を残す方法、root 参照の切り離し、upload 履歴の保持、独立削除済み子の扱いを含む FK グラフ全体の削除契約を定義してください。外部キー無効化で回避すべきではありません。

[DESIGN.md:186-215](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

---

## D-06：D1 の fence 検査では、遅延した R2 delete を止められない

**致命／実装前に直すべき — 契約不足**

**根拠：** §11.3「旧 fence の worker は削除権限を失う」、§14.2「全副作用は現在 fence を照合」。

- **前提状態：** GC worker G が fence=10 を保有。blob B は猶予終了・参照なし。
- **操作列：**
  1. G が primary で参照と fence を確認する。
  2. G が R2 delete の直前、または送信後の応答待ちで遅延する。
  3. lease が切れ、新 fence が発行される。別途、restore が開始される。
  4. D1 restore により B への参照が戻る。
  5. G の R2 delete が実行・完了する。
- **結果：** 復旧した D1 は B を参照するが、R2 の B は消える。

R2 Workers API の `delete(key | keys)` には D1 fence を渡す引数がありません。**削除前に fence を読むことと、削除先が fence を強制することは別です。**

通常運転でも、参照再追加と削除の間には同様の条件が必要です。`blobs.state='deleting'` は列挙されているだけで、参照追加を原子的に拒否する遷移がありません。

**必須修正：**

- D1 で不可逆な `deleting` への遷移を確定し、それ以降の参照追加を禁止する。
- COPY／ZIP／backup 等の保持が必要なら、単なる manifest ではなく GC が認識する pin を持つ。
- restore 前に削除処理の新規受付を停止し、進行中の不可逆処理を収束させる。
- D1 内の fence と、R2 副作用の安全性を分けて証明する。

---

## D-07：失敗 upload の予約を解放すると、物理容量 quota を迂回できる

**重大／実装前に直すべき — 契約不足**

**根拠：** §5.2 手順6、§6.2、§11.3 の7日猶予。

- **前提状態：** owner の空き quota が Q。攻撃者はその space の編集権限を持つ。
- **操作列：**
  1. Q 以下の大きい upload を開始し予約する。
  2. R2 書き込みを完了させる。
  3. 別操作で対象 revision を進め、complete の CAS を失敗させる。
  4. §5.2 に従い新 blob を GC 候補にし、予約を解放する。
  5. 同じ手順を反復する。
- **結果：** 各 upload は quota 予約を守っているのに、R2 に7日間残る失敗 blob が積み上がる。論理 quota が物理使用量の上限にならない。
- **不足：** staging／失敗 blob の課金状態、削除待ち容量の保持勘定がない。

また §11.1 は purge の処理順に `quota` を含め、§11.3 は R2 削除後に `used_bytes` を確定するとしています。減算主体が曖昧です。

**必須修正：** `reserved → stored-but-unpublished → committed → deletion-pending → physically-deleted` の容量台帳を定義し、失敗時も物理削除前に容量を無条件解放しないこと。未課金 staging blob の GC で `used_bytes` を減らさない条件も必要です。

---

## D-08：GC 7日と、復旧可能な backup／Time Travel の期間が接続されていない

**重大／実装前に直すべき — 契約不足**

**根拠：** §11.3、§11.4。

- **前提状態：** 日次 backup S は blob B を参照している。
- **操作列：**
  1. B を参照する node を purge する。
  2. 7日後、通常 GC が B を削除する。
  3. 後日、S または purge 前の Time Travel bookmark へ復旧する。
- **結果：** D1 は戻るが、B は戻らない。

D1 Paid の Time Travel は公式仕様上30日ですが、R2 は一緒に巻き戻りません。本文が30日すべての復旧を保証したとは断定しません。しかし、**安全に選択できる復旧点の範囲が未定義**です。

§11.3 の「thumb / backup 区分を再確認」が、backup オブジェクト自身を除外するだけなのか、backup manifest が参照する全 blob を保持するのかも不明です。

**必須修正：** 対応する復旧期間を明示し、その期間内の snapshot 参照を pin するか、R2 の削除保留期間を整合させること。復旧時の存在確認は欠損を検出するだけで、欠損を防ぎません。

---

## D-09：Time Travel が失効情報・revision・fence を巻き戻す

**重大／実装前に直すべき — 契約不足**

**根拠：** §8.1、§11.4、`shares.share_version`、`job_leases.fence`、`settings.gc_paused`。

- **前提状態：** share version 1 の署名 Cookie がまだ暗号学的には有効。
- **操作列：**
  1. owner が password 変更／revoke を行い version 2 にする。
  2. 管理者が version 1 の時点へ D1 を restore する。
  3. key ring はそのまま再投入する。
  4. version 1 Cookie を再送する。
- **結果：** D1 上も version 1 に戻るため、失効済み Cookie が復活する。app password の失効・ユーザー停止も同型。

さらに、restore 対象 DB 内にある `gc_paused=true` 自体が false に戻り得ます。fence、operation result、node revision も巻き戻ります。

**必須修正：** 復旧対象 D1 の外側に recovery epoch／maintenance 制御を置き、旧 ticket・旧非同期処理を無効化すること。資格情報の復旧後ポリシー、Cron／Queue の再開順序も必要です。

---

## D-10：COW コピー先だけの編集権限で、コピー元の thumbnail を汚染できる

**重大／実装前に直すべき — 反例あり、client thumb への key 適用範囲が未分離**

**根拠：** §3.4、§10.1、§10.3。

派生物 key は次の形式です。

```text
u/<ownerId>/t/<blobId>/<variant>-g<generatorVersion>.webp
```

- **前提状態：**
  - private file F と、共有先の COW copy G が同じ blob B を参照する。
  - grantee は G のみ編集できる。
- **操作列：**
  1. grantee が G に対して client thumb POST を行う。
  2. 正しい G／B／generator version と、有効な別画像を送る。
  3. server が共通の B 用 key に保存する。
  4. owner が F の thumbnail を取得する。
- **結果：** F に対する編集権限なしに、F の thumbnail 表示を変更できる。画像形式の再検査・再 encode では防げません。
- **不足：** node 単位の編集権限に対し、保存先が blob 単位で共有されている。

同じ理由で、G の purge が共有 derivative key を削除すると、F の thumbnail も失われ得ます。

**必須修正：** server が内容だけから生成する共有 derivative と、node ごとの未信頼 client thumb を別 key／別参照管理にすること。

[DESIGN.md:527-547](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

---

## D-11：「従属 statement を同じ期待 revision で guard」だけでは batch が壊れる

**致命／実装前に直すべき — 契約不足**

**根拠：** §3.5、§5.2。`operations` の具体的な状態・SQL は未定義。

- **前提状態：** F は revision 7、upload の quota は予約済み。
- **操作列：**
  1. batch の最初の statement が `WHERE revision=7` で F を revision 8 に更新する。
  2. 後続の versions／quota／outbox 更新を、同じ `nodes.revision=7` の存在条件で guard する。
  3. 後続はすべて0行になる。
  4. SQL エラーは発生しないため batch は成功する。
- **結果：** node 参照だけ切り替わり、旧世代・quota・operation result が追随しない。

これは「guard を付けたから安全」ではない具体例です。batch 完了後に0行を検出して409を返しても、既に確定した最初の更新は取り消せません。

**必須修正：** 検査成功を安定した operation claim に記録し、その claim を全従属更新が参照する等、**statement 順序込みの確定 SQL 契約**が必要です。D-01 の安全性もこれに依存します。

---

# 2. 認可・capability・IDOR

## A-01：node 認可だけでは、複数対象操作と非 node ID を保護できない

**重大／実装前に直すべき — 契約不足**

**根拠：** §4.1 の `authorize(principal,node,action)`、§4.3、§5.1、`uploads`／`operations`／`bulk_jobs`。

### 具体的な経路

- **前提状態：** app password は rw だが folder R に限定。
- **操作列：**
  1. R 内の F を source にして WebDAV MOVE を送る。
  2. `Destination` に同じ owner の R 外の folder を指定する。
  3. source F の write と owner 一致だけを検査する。
- **結果：** scope 外へ配置できる。
- **不足：** 表の write 行は「rw のみ」で、source、source parent、destination parent、置換先それぞれの scope 検査が明文化されていない。

COPY は逆方向も必要です。destination だけ認可して source の読取りを省略すると、他者 node の ID を指定してコピーできてしまいます。同一 host 判定では防げません。

### ID ごとに必要な結び付け

| ID | 攻撃操作 | 本文で固定すべき検査 |
|---|---|---|
| `node_id` | 許可 node と許可外 destination／置換先を混在 | 全 operand を同じ principal の現在 scope で検査 |
| `blob_id` | 許可 node と別 blob を組み合わせて content／thumb／ticket を要求 | node と blob 世代の関係を検査。blob ID 単体を権限にしない |
| `upload_id` | 他の upload を GET、part 置換、abort、complete | 保存先 owner だけでなく、開始主体・share／credential・session capability を検査 |
| `share_id` | share holder が管理 PATCH／DELETE を要求 | link possession と共有管理権限を分離 |
| `job_id` | 他人の job の進捗取得、cancel、retry | 作成主体、対象 space、現在の操作権限を検査 |
| operation／idempotency key | 他人の key、または同じ key で異なる payload を送る | principal／space／操作種別で名前空間化し、request digest 不一致を拒否 |

`uploads.owner_id` は保存先 owner、`actor_id` は nullable です。匿名 share の識別、開始時 share version、app credential ID を何に保存するかは未定義です。UUID の推測困難性では代替できません。

内部共有の `GET /api/v1/nodes/:id/path` も、末端 node の認可だけで完全な祖先 path を返すと、共有外の祖先名を漏らします。認可 root で表示 path を打ち切る契約が必要です。

---

## A-02：blob-only ticket が、共有外へ MOVE された node を追跡できない

**重大／実装前に直すべき — 契約不足**

**根拠：** §8.2 の ticket 内容と「後続 request でも share 失効・node 削除を検査」、§4.1 の全 content 共通認可。

- **前提状態：** folder share R の配下に F があり、blob B の ticket T を発行済み。
- **操作列：**
  1. owner が F を R 外の private folder へ MOVE する。
  2. R の share 自体は有効、`share_version` も変わらない。
  3. T で新しい Range request を送る。
  4. share 有効・blob 存在・node 未削除だけを検査する。
- **結果：** 現在の capability subtree 外から内容を取得できる。
- **不足：** ticket の定義に `node_id` がなく、同じ blob を複数 node が参照する COW では blob から元の対象を一意に復元できない。

**必須修正：** ticket に対象 node／固定 blob 世代／用途を結び付け、毎回、現在の有効 subtree との関係を確認すること。固定 snapshot として旧 blob を配る方針と、現在の認可判定は別に定義してください。ZIP manifest の各 entry も同様です。

---

## A-03：署名済み download ticket を unlock Cookie として使う用途混同

**重大／実装前に直すべき — 契約不足**

**根拠：** §8.1「unlock Cookie / ticket は `share_id, share_version, exp, kid` を含む署名済み値」。

- **前提状態：** password 保護された folder share。第三者は単一ファイルの download ticket だけを受け取った。
- **操作列：**
  1. ticket を unlock Cookie の値として送る。
  2. 共通 verifier が署名・share ID・version・expiry だけを確認する。
  3. ticket 固有の `blob_id` を追加 field として無視する。
- **結果：** 単一ファイル ticket が folder 全体の unlock に昇格する。
- **不足：** `typ`／`aud`／purpose、許可 action、必須・禁止 claim の区別がない。

これは署名の偽造ではありません。**正しく署名された、用途の異なる値の再利用**です。

**必須修正：** unlock、download、content-host 配信、upload session を用途分離し、route が期待する型以外を拒否すること。許可アルゴリズム・鍵選択も固定する必要があります。

一方、単なる `share_version` 改変や `blob_id` 改変は、署名検証が正しければ防げます。password 変更後の旧 Cookie も primary の version 照合で防げます。ただし D-09 の restore 巻き戻りは別問題です。

---

## A-04：upload-only の直接上書きは禁止できるが、衝突名が存在確認 oracle になる

**中／実装時に注意 — 直接攻撃は防御規定あり、応答仕様は不足**

**根拠：** §4.3、§8.3。

- **前提状態：** upload-only share の root に、存在を知られたくない名前がある。
- **操作列：**
  1. 攻撃者が推測した名前で小さい file を送る。
  2. server が衝突時だけ `name (2)` 等へ変更する。
  3. 結果の名前、status、エラー差を返す。
  4. 名前を変えて繰り返す。
- **結果：** 一覧 API を使わず既存名の存在を推測できる。
- **既存防御：** list、read、任意 node ID、overwrite 禁止は明確。これらの直接攻撃は拒否できる。
- **必要な注意：** upload-only の返却情報を receipt に限定し、既存名の有無を区別しない命名・応答にすること。決定的 suffix を返す場合は、この情報漏えいを受容するか明示してください。

---

## A-05：Access Bypass から private API へのフォールスルー

**低／受容可 — 防御規定あり**

**根拠：** §2.2、§4.2、§14.3。

- **前提状態：** 未認証アクセス、または Access 設定が誤って広く Bypass。
- **操作列：**
  1. `/api/v1/public/…` の未知 route、private API、private SPA を要求する。
  2. Access JWT や share Cookie を別方式の資格情報として混在させる。
- **結果：** 本文どおりなら、未知 public route は404、private は Worker の Access 検証で拒否。自動昇格もしない。
- **防ぐ規定：** 単一 route manifest、フォールスルー禁止、`run_worker_first: true`、private 側で share Cookie を解釈しないこと。

ただし、以下の文書上の矛盾は解消が必要です。

- §7.1／§18.1：DAV は **app password Basic のみ**。
- §13.2：DAV は **Basic / mapped Service Token**。

これは同じ認証境界についての相反する契約です。

---

## A-06：ticket の転送・Range 再利用・失効前に受信した cache

**低／受容可 — 明示された制約として妥当**

**根拠：** §8.2。

- **前提状態：** 正当な利用者が ticket または内容を取得済み。
- **操作列：** ticket を他者へ渡す、同一 ticket で Range を再利用する、受信済み内容を cache から読む。
- **結果：** 人数・コピー回数の厳密な制限にはならない。
- **判定：** `download_count` を「ticket 発行数」と定義し、既受信 bytes の回収を保証しないため、設計上の認可バイパスとは扱いません。

ただし、再利用による費用増幅は C-03 の問題として残ります。

[DESIGN.md:486-506](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

---

# 3. WebDAV 固有の攻撃

## W-01：`lockdiscovery` で得た token によるロック横取り

**重大／実装前に直すべき — 契約不足**

**根拠：** §7.3。取得 principal／credential の一致を要求しているのは **refresh／UNLOCK**。

- **前提状態：** Alice と Bob は同じ file の編集権限を持つ。Alice が exclusive LOCK を取得。
- **操作列：**
  1. Bob が PROPFIND `lockdiscovery` で token T を得る。
  2. Bob が `If: (<T>)` を付けて PUT／PROPPATCH／MOVE する。
  3. server が通常の write 権限と token 一致だけを検査する。
- **結果：** Alice のロックを Bob が利用して書き込める。

RFC 4918 §6.4 は、**locked resource の変更時にも認証 principal と lock creator の一致**を要求します。token が公開されることは仕様上許容されるため、token の秘匿性には依存できません。

**必須修正：** refresh／UNLOCK だけでなく、すべての locked mutation に所有主体照合を適用してください。credential 単位まで分離するなら principal の構造にも credential ID が必要です。

---

## W-02：同じ space にしても、共有 mount の別名 URI でロックを迂回できる

**重大／実装前に直すべき — 契約不足**

**根拠：** §7.3 の `normalized URI`、§8.3 の `/dav/Shared/<stable-mount>/`。

- **前提状態：**
  - owner からは `/dav/Reports/F`。
  - grantee からは `/dav/Shared/<mount>/F`。
  - 両方とも同じ owner space／同じ node。
- **操作列：**
  1. owner が自分の URI を LOCK。
  2. grantee が mount 側 URI で PUT。
  3. 同じ LockDO 内で、文字列として異なる URI を検索する。
- **結果：** 同じ実体へのロックを見落とす。同じ subtree を複数 mount した場合や casefold の別表記も同型。
- **不足：** URL 正規化と、共有 mount を owner 名前空間へ写像する処理は別。

**必須修正：** lock root／ancestor／Destination を、保存先 space の一意な名前空間表現へ写像すること。そのうえで MOVE 元 lock を終了する URI 意味論を保つ必要があります。単純な node ID 追従への変更も不適切です。

---

## W-03：lock 検査後、D1 commit 前に新しい LOCK が取得される

**重大／実装前に直すべき — 契約不足**

**根拠：** §5.2 手順2→4→5、§7.3。

- **前提状態：** F は unlocked。
- **操作列：**
  1. REST PUT が LockDO の検査・operation 予約を通る。
  2. R2 書き込み中に別 client が F を LOCK し、成功応答を得る。
  3. REST PUT が token なしで D1 commit する。
- **結果：** LOCK 成功後にロック非保持者の更新が確定する。
- **不足：** operation 予約中の LOCK 拒否／待機、commit permit の世代、Worker 停止時の解放が未定義。

逆に、解決策として owner space 全体を低速 upload の間ずっと排他すると、一つの upload で他者の全書き込みを止められます。

**必須修正：** 長時間転送と短い namespace commit を分け、LOCK と commit の順序を永続状態で調停してください。

---

## W-04：revision だけの collection ETag は URI 再利用で ABA を起こす

**重大／実装前に直すべき — 反例あり**

**根拠：** §3.4、§5.3「WebDAV collection `getetag` は revision」。

- **前提状態：** client が `/dav/X/` を読み、ETag `"3"` を保持。
- **操作列：**
  1. owner が元の X を別名へ MOVE。
  2. 別 folder Y を `/dav/X/` へ配置する。Y の revision も3になるよう操作する。
  3. stale client が `/dav/X/` に `If-Match: "3"` 付き DELETE／変更を送る。
- **結果：** client が読んでいない別 folder Y に条件が一致してしまう。

RFC 4918 §8.8 は、同じ URL の異なる表現に ETag を再利用してはいけないとしています。

**必須修正：** DAV の validator に node identity と revision、必要なら recovery epoch を含めること。REST の ID 固定 URL と、再利用される DAV path の validator を同じ前提で扱えません。

---

## W-05：その他の WebDAV 攻撃の判定

| シナリオ | 前提 → 操作 → 結果／防御規定 | 判定 |
|---|---|---|
| `If:` の常真条件 | locked file に `If: (Not <DAV:no-lock>)` を送る。If 自体は真でも必要な lock token はない。§7.3 の独立した lock 検査で拒否すべき | **中／実装時に注意** |
| 他 space の token | space A の token を space B の変更に添付。token の存在だけで許可せず、space・URI scope・creator を照合すれば拒否できる | **中／実装時に注意** |
| 複合 `If:` の誤実装 | 別 resource の tagged list だけを真にして、対象の lock を省略。条件式の真偽と token submission／必要 lock の検査を分離すれば拒否できる | **中／実装時に注意** |
| `Destination` に外部 host | COPY／MOVE で外部 URL を指定。§7.2 の同一 host・`/dav/` 制限で拒否。本文に外部 URL を fetch する経路はなく、SSRF 成立とは判定しない | **低／受容可** |
| 同一 host の跨ぎ移動 | 別 owner／scope 外の DAV mount を Destination にする。同一 host 判定だけでは不足。別 owner MOVE は §3.2 で禁止、同一 owner の scope 越えは A-01 | **重大／実装前に直すべき** |
| XML 爆弾・XXE | PROPFIND／PROPPATCH／LOCK body に DTD・entity・深い nesting を送る。§7.2 の parser 禁止設定、1 MiB／深さ32上限で拒否できる | **低／受容可** |
| protected property 改変 | DAV namespace の `getetag`／`lockdiscovery` 等を別 prefix で PROPPATCH。expanded name で判定すれば §7.2 により403、他 property も全失敗 | **中／実装時に注意** |
| 二重 decode | `%252e%252e`、encoded slash／backslash を path／Destination／tagged URI に使う。§2.2・§3.3 の一回 decode・拒否規定で防げる | **中／実装時に注意** |
| `Timeout: Infinite`／再起動 | 長寿命 LOCK を要求し DO を再起動させる。最大1h・SQLite 永続化・各 request の expiry 検査で無期限 lock を防ぐ | **低／受容可** |
| 有効 credential による継続 refresh | 期限前の refresh を永久反復する。1h は各 lease の長さであり総保持時間ではない。RFC 上あり得る動作で、管理 recovery を用意済み | **低／受容可** |

`If:` では「真と評価された branch 内の token だけを提出済みとみなす」という独自実装も誤りです。RFC は条件式評価と token submission を区別しています。

また、Request URI だけ正規化して Destination／tagged URI は別の decoder に任せると、二重 decode 防御は成立しません。

[DESIGN.md:459-480](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

---

# 4. DoS・コスト攻撃

## C-01：ZIP は1リクエストで既定 subrequest 上限を超え、4 GiB 未満でも壊れる

**重大／実装前に直すべき — 反例あり**

**根拠：** §5.3、§8.2、§13.1。

### 経路A：65,000 entry

- **前提状態：** 公開 folder share に小さい file が65,000個あり、総量は4 GiB未満。
- **操作列：**
  1. ZIP ticket を発行する。
  2. ZIP を GET。
  3. 各 file を R2 `get()` して stream する。
- **結果：** 本体だけで65,000回の R2 GET。既定10,000 subrequests を超え、途中で壊れた ZIP になる。

現在の Workers Paid は subrequest 上限を設定で増やせますが、§14 の例には設定がなく、アプリ側の費用・呼出数予算もありません。設定を増やすだけではコスト対策になりません。

### 経路B：ZIP header 分の32bit overflow

- **前提状態：** STORE 相当で出力する2 file。非圧縮合計は `4 GiB - 1 byte`、各 file は4 GiB未満。
- **操作列：** §5.3 の全事前検査を通して ZIP を生成。
- **結果：** 最小限の local header を加えただけでも central directory 開始位置が32bitを超えます。

```text
入力合計                    4,294,967,295
2個の最小 local header 加算 4,294,967,357
uint32 最大                 4,294,967,295
```

**必須修正：** entry 数だけでなく R2／D1 呼出数、manifest bytes、圧縮最悪値、header／descriptor／central directory を含む出力上限を開始前に検査してください。

---

## C-02：0-byte file・COW・dead property で D1 を満杯にする

**重大／実装前に直すべき — 契約不足**

**根拠：** §6.2 の物理 blob quota、§7.2、§7.3、§13.1 の D1 10 GB。

- **前提状態：** rw app password、または内部 edit share。
- **操作列：**
  1. MKCOL、0-byte PUT、未存在 URL への LOCK を反復する。
  2. 同じ blob を参照する COW copy を大量作成する。
  3. PROPPATCH を繰り返し、毎回異なる dead property 名を追加する。
- **結果：** `nodes`、`node_props`、FTS、activity、operations、outbox、LockDO storage が増える一方、blob byte quota はほぼ増えない。
- **不足：** XML の1 request上限はあっても、node 当たり property 総量、space 当たり node 数、metadata bytes、operation 履歴量の上限がない。

さらに巨大 folder に対する **Depth:1 PROPFIND** は深さ制限を守っていても高コストです。`allprop` なら保存した dead properties も展開されます。

§17 の「paged PROPFIND」は、標準 WebDAV client が使える pagination 契約にはなっていません。黙って途中まで返すと同期 client の誤動作を招きます。

**必須修正：** metadata quota、folder 幅、property 総量、PROPFIND 応答予算と超過時の互換動作を定義してください。

---

## C-03：一つの download ticket から Range／retry コストを増幅する

**重大／実装前に直すべき — コスト契約不足**

**根拠：** §8.2、§4.4、§13.4。

- **前提状態：** `max_downloads=1` の公開共有から ticket を一つ取得。
- **操作列：**
  1. 同一 ticket で異なる短い Range を大量に要求する。
  2. 複数接続・複数 location から繰り返す。
  3. ZIP ticket なら生成途中で切断し、最初から再要求する。
- **結果：** `download_count` は増えず、primary D1 認可、R2 Class B、Worker request、ZIP CPU が増える。
- **不足：** ticket 発行数は request 数・配信 bytes・並列数・ZIP 再生成回数の上限ではない。重要な DO 上限の例は password 試行・session 数で、配信予算は定義されていません。

**必須修正：** share／ticket／owner／全体の配信 operation 予算と並列数、Range の扱い、切断時 cancellation を定義すること。

---

## C-04：part の置換と低速転送で、容量を増やさず Class A／DO 時間を消費する

**重大／実装前に直すべき — コスト契約不足**

**根拠：** §6.2、§6.3、§8.3。

- **前提状態：** upload-only share の session を一つ確保。
- **操作列：**
  1. `active` の間、同じ part number を異なる内容で繰り返し置換する。
  2. 最終進捗期限に近づく前に再送する。
  3. 各 request の送信を遅くして接続を維持する。
- **結果：** 最終 file bytes・session 数を増やさず、R2 Class A、DO request／active duration を消費する。
- **既存防御：** 作成から最大7日なので一つの session が永久には続かない。
- **不足：** session 当たり転送累積 bytes、part 試行回数、in-flight 数、転送 deadline がない。

また、part の番号・宣言サイズから導く expected size を **受入前**に検証する必要があります。complete 時だけの総量検査では、小さい予約で大量の未完了 parts を保存する実装を排除できません。

---

## C-05：Images／Queue の「結果冪等」は「費用冪等」ではない

**重大／実装前に直すべき — コスト契約不足**

**根拠：** §10.1、§10.2、§10.3、§14.2。

- **前提状態：** thumbnail job の重複配信、または同じ current blob への client thumb POST が可能。
- **操作列：**
  1. 複数 consumer が同じ仕事を受け取る。
  2. 重い Images 変換／WASM decode を実施する。
  3. 最後の D1 更新でだけ世代・重複を検査する。
  4. 結果保存前に停止し、retry／repair が再実行する。
- **結果：** current thumb は正しくても、Images 変換、R2 GET／PUT、Queue 操作、CPU は重複課金される。共通 derivative key への書込み競合は429と retry も誘発する。

**必須修正：** 重い処理前の job claim、variant／生成世代のサーバ側 allowlist、retry 総予算、owner ごとの生成予算が必要です。

WASM の8 MiB／12 MPは40 MPより改善していますが、**batch 内で一件ずつ**でも isolate 内の他 invocation と重なる可能性があります。ピークメモリと安全な同時実行数は **要確認**です。

---

## 1リクエストで最も高コストな操作と上限

異なる service の料金は単純比較できません。現設計では、次の操作について「安全な最大費用」を計算できません。

| 経路 | 最も危険な操作 | 主な増幅 | 現在の上限評価 |
|---|---|---|---|
| 公開 read share | ZIP GET | 最大65,000 R2 GET、manifest 読取り、圧縮、繰り返し生成 | 数値はあるが既定 platform 予算と不整合 |
| 公開 read share | 大容量 content の低速配信／Range 反復 | Worker 継続、R2 Class B、primary 認可 | file 上限はあるが、ticket 全体の費用上限なし |
| upload-only | part 反復置換 | R2 Class A、DO request／時間 | 完成容量・session 数だけでは制御不可 |
| WebDAV | 広い folder の Depth:1 `allprop` | D1 rows read、XML 応答量 | 深さ以外の具体的上限なし |
| WebDAV rw | PROPPATCH／空 node 大量作成 | D1 rows written／storage、監査、lock storage | 累積 metadata 上限なし |
| REST／内部 edit | 巨大 folder COPY の bulk job 開始 | 一つの開始要求から N node／outbox／Queue に展開 | invocation 予算はあるが、job 全体の受付上限なし |

HTTP／DO の接続が続く間の wall time は、CPU 上限とは別です。「CPU 30秒だから低速転送も30秒で止まる」とは扱えません。

---

# 5. 状態機械の穴

本文の状態図と、必要な異常遷移を照合した結果です。

| 対象 | 前提 → 操作列 → 到達する穴 | 必要な契約 | 判定 |
|---|---|---|---|
| `UploadDO.initiating` | D1 quota 予約 → R2 multipart 作成 → `active` 永続化前に停止。Cron abort は `active` のみ | initiating の期限・再照合・失敗終端。R2 upload ID 保存前の停止も回収対象にする | **重大／実装前に直すべき** |
| `UploadDO.completing` | R2 complete 成功 → D1 CAS 412／共有失効403。図には `committed` 以外への出口がない | `conflicted/rejected/failed` 等の終端、R2 完了済み blob の回収・課金移管 | **重大／実装前に直すべき** |
| in-flight part と complete | part n の E1 が記録済み → E2 への置換 I/O 開始 → complete が E1 で集合固定 → R2 側は E2 に置換 | 完了前の part barrier。新規 part 拒否だけでは開始済み I/O を止められない | **重大／実装前に直すべき** |
| complete と R2 lifecycle | 7日直前に `completing` → R2 の未完了 upload lifecycle が abort → complete は失敗、Cron は completing を扱わない | lifecycle より早い complete deadline、R2 upload 消滅時の失敗終端 | **重大／実装前に直すべき** |
| DO／D1 terminal 差 | D1 committed → DO 更新前に停止。DO は completing のまま | D1 terminal result を優先する照合規則。DO を根拠に再課金・再確定しない | **重大／実装前に直すべき** |
| `trash_ops` | 子孫処理／restore／purge が別々に進む | 状態集合・許可遷移・各 chunk の世代条件。D-04／D-05 | **致命／実装前に直すべき** |
| `gc_candidates`／`blobs` | 検査済み candidate → 新参照／復旧 → 遅延 delete | 不可逆 deleting、参照追加禁止、pin、物理削除結果の冪等台帳。D-06 | **致命／実装前に直すべき** |
| `job_leases` | 現 fence 確認 → 外部 I/O → lease 失効 | D1 の変更には同一 statement／batch の fence guard。外部副作用には別の安全プロトコル | **致命／実装前に直すべき** |
| `outbox` | Queue send 成功 → sent 記録前停止 →再送。逆に sent の message が保持期限で消滅 | outbox ID＝論理 job ID、sent と completed を区別し、再配送・terminal result・repair 条件を定義 | **重大／実装前に直すべき** |
| thumbnail＋DAV lock | Queue consumer が §5.2 の lock 検査で423 → retry →長期 lock で DLQ | 派生物が lock 対象か、待機対象か、いつ retry を消費するかを定義 | **中／実装時に注意** |
| backup export | base scan 後に行を DELETE → journal から「現行行を再読」するだけでは tombstone が得られない | commit 順 journal、削除記録、開始／終了 watermark、全対象 table の範囲 | **重大／実装前に直すべき** |

`reconciler`、`pending 修復 job`、`冪等`という名称は追加されています。しかし、**どの状態を正として、どの状態へ収束させるか**が不足しています。

特に outbox は at-least-once を前提にしている点は正しいものの、Queue の送信成功は job 完了ではありません。現在の公式仕様では保持期限に達した message は削除されます。

[DESIGN.md:429-440](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)
[DESIGN.md:710-730](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/DESIGN.md)

---

# 6. ラウンド1「採用」項目の照合

**「本文に文言がある」と「安全性が確定した」を分けて評価しました。**

| 前回ID | v0.2 の反映先 | 抜き取り結果 |
|---|---|---|
| B-01 不変 blob／確定点 | §3.4、§5.2 | **反映あり**。通常の並行 PUT の方向は正しい。ただし D-11 の SQL 契約が未確定 |
| B-02 正本／復旧／GC | §11.3–11.4 | **部分反映**。backup 参照 blob の保持と復旧期間、外部の pause／epoch が不足 |
| B-03 root／tree 不変条件 | §3.2 | **部分反映**。実体 root は修正済み。並行 MOVE の原子的な循環防止は未解決 |
| B-04 quota 予約 | §6.2 | **部分反映**。owner の原子的予約はあり。失敗 blob の物理容量、share ごとの原子的予約台帳は未定義 |
| B-05 trash／purge | §11.1 | **部分反映**。既削除子の分離はあり。restore／purge 排他と `trash_ops` 等の FK が未解決 |
| B-06 LockDO／共通 mutation | §5.2、§7.3 | **部分反映**。保存先 owner 単位は正しい。alias URI と commit までの調停が不足 |
| B-07 UploadDO | §6.3 | **部分反映**。正常遷移は追加。initiating／completing の失敗出口がない |
| B-08 認可 matrix | §4.3 | **部分反映**。capability 制約は明確化。複数 operand、upload／job／operation ID の認可が不足 |
| B-09 route 境界 | §2.2、§14.3 | **反映あり**。公開 prefix、404、Worker-first、domain 制限が整合 |
| B-10 CSRF／CSP 分離 | §7.1、§10.4、§13.2 | **部分反映**。分離は正しいが DAV の Service Token 許可が矛盾 |
| B-11 サイズ・転送 | §6.1 | **概ね反映あり**。95 MB、64 MiB、500 GiB、長さ不明411を分離 |
| B-12 Images／WASM | §10.2、§18.2 | **反映あり、実測条件付き**。20 MB、8 MiB／12 MP、無条件 fallback 禁止あり |
| B-13 ZIP | §5.3 | **未解決**。4 GiB の入力上限では出力 offset を保証せず、65,000件は既定 subrequest 予算を超える |
| B-14 lease／fencing | §14.2 | **部分反映**。KV mutex は廃止。R2 副作用に fence が効く根拠は未定義 |
| B-15 bootstrap | §4.2 | **反映あり**。OWNER_EMAILS、fail closed、signup false、最後の owner 保護あり |
| M-01 D1 batch／索引 | §3.5、§13.1 | **概ね反映あり**。100 bind、keyset、primary 方針あり。batch 全体の時間上限も明示した方がよい |
| M-02 KV path cache | §3.5、§7.1 | **部分反映**。hint 化は正しい。`space_generation` の保存先・更新条件がない |
| M-03 ETag 分離 | §3.4、§5.3 | **部分反映**。content と metadata は分離。DAV URI 再利用時の revision-only ETag が不十分 |
| M-04 COPY | §3.4 | **部分反映**。COW／get→put／manifest は明記。大容量 cross-owner COPY の multipart・再開・保持 pin が不足 |
| M-05 DAV 意味論 | §7 | **部分反映**。XML／protected props は改善。lock creator の変更時照合と alias が不足 |
| M-07 Queue／世代 | §10.1 | **部分反映**。payload と current blob 検査はあり。outbox 終端、費用重複、client thumb key 衝突が残る |
| M-08 browser 再開 | §6.4 | **反映あり**。再選択、fingerprint、incremental hash、declared／verified 分離あり |
| M-09 検索 | §12 | **反映あり**。専用表、候補＋順序照合、scope join、1文字制限あり。具体的 scan 上限は未確定 |
| M-10 KDF／rate limit | §4.4 | **反映あり**。app secret HMAC、人間 password KDF、先行 rate limit を分離 |
| M-11 Access identity | §4.2 | **反映あり**。iss+sub、email 自動結合禁止、disabled、JWT 検証あり |
| M-12 share 失効 | §8 | **部分反映**。version と cache 方針は改善。ticket の型・node 対応、復旧時の失効巻き戻りが未解決 |
| M-13 preview／thumb | §10.3–10.4 | **部分反映**。origin 分離と入力検証はあり。COW 間の client thumb 権限境界は未解決 |
| M-14 job 予算 | §14.2 | **部分反映**。予算の分類は追加。具体値・job 全体の受付上限がない |
| M-17 障害試験 | §15.2 | **反映あり**。13項目は列挙済み。ただしテスト項目の追加は、安全プロトコルの定義の代わりにはならない |
| m-06 公開 upload endpoint | §5.1 | **部分反映**。public upload 作成はあるが、public part／status／complete／abort の route がない |

[round1-resolution.md](file:///C:/Users/Administrator/repos/Next-cloud-flare/docs/reviews/round1-resolution.md)

## 追加の自己矛盾・数値上の注意

1. **公開 multipart の route 不足**
   - 作成：`/api/v1/public/shares/:token/uploads`
   - part／complete 等：表には private `/api/v1/uploads/:id/...` のみ。
   - §2.2 を厳守すると匿名利用者は完了できません。private 側を場当たり的に Bypass して直してはいけません。

2. **DAV 認証の矛盾**
   - §7.1／§18.1 の Basic のみと、§13.2 の Service Token 許可が不一致。

3. **purge と GC の quota 確定主体**
   - §11.1 の purge 手順と §11.3 の物理削除後精算を、一つの容量台帳で統一する必要があります。

4. **part size を下げた場合の実効 file 上限**
   - 500 GiB／64 MiB＝**8,000 parts**。
   - 500 GiB／8 MiB＝**64,000 parts**。
   - §6.1 の `partSize × 10,000` による引下げを実装すれば安全ですが、8 MiB 設定では500 GiBを受け入れられません。UI が実効上限を表示すべきです。
   - 100 GB≒1,491 parts、100 GiB＝1,600 parts の記述は正しいです。

5. **大容量 cross-owner COPY**
   - §3.4 は一つの `get() → put()` で500 GiBまで扱えるように読めます。
   - 公式 upload guide は single PUT と multipart の上限を分けています。一方 Limits の subrequest に関する注記もあるため、**採用 binding での厳密な上限適用は要確認**。
   - 少なくとも巨大 copy の再開可能性・時間・quota 解放・source 保持は未定義であり、一発 stream copy を公称500 GiB対応の根拠にはできません。

---

# 7. Cloudflare 仕様の確認範囲

今回、公式資料で確認できた主要事項です。

| 項目 | 確認結果／注意 |
|---|---|
| Workers Paid subrequests | 既定10,000。現在は設定で増加可能。設計の65,000-entry ZIPが既定値に収まるわけではない |
| Workers memory | 128 MB／isolate。request 単位ではない |
| HTTP／DO wall time | 接続継続中の時間と CPU 上限は別。低速転送のアプリ deadline が必要 |
| D1 | 10 GB／DB、100 binds、1,000 queries／Paid invocation。30秒上限には batch call 全体への注意書きもある |
| D1 Time Travel | Paid は30日。R2 の復旧を意味しない |
| R2 delete | key または key 配列を受ける API。D1 fence を検査させる引数はない |
| R2 multipart | 未完了 upload は既定で7日後に abort。実際の lifecycle 設定とアプリ期限の余裕は**要確認** |
| Queues | at-least-once、保持期限到達 message は削除、consumer wall time 15分 |
| Images binding | `.input()` 最大20 MB。codec／契約／WASM peak memory は**要確認** |

主な出典：

- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [D1 limits](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [R2 Workers API](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)
- [R2 limits](https://developers.cloudflare.com/r2/platform/limits/)
- [R2 upload guide](https://developers.cloudflare.com/r2/objects/upload-objects/)
- [Queues limits](https://developers.cloudflare.com/queues/platform/limits/)
- [Images limits](https://developers.cloudflare.com/images/get-started/limits/)
- [RFC 4918](https://www.rfc-editor.org/rfc/rfc4918.html) — 特に §6.4、§8.8、§10.4

---

# 8. 実装へ渡すための必須修正

| 優先度 | 必須修正 | 主な対応先 |
|---|---|---|
| **P0** | `fsMutation` の statement 順序、operation claim、成功／競合時の全従属更新を具体化 | D-01、D-11 |
| **P0** | tree・祖先削除・認可失効を commit と整合させ、相互 MOVE の循環を防止 | D-02、D-03 |
| **P0** | trash／restore／purge の排他的状態機械と FK 削除計画を完成 | D-04、D-05 |
| **P0** | GC の不可逆 deleting、参照 pin、R2 副作用と復旧の調停を定義 | D-06、D-08 |
| **P0** | D1 の外側に復旧時の停止制御／epochを置き、旧資格情報・旧 job の再利用を防止 | D-09 |
| **P0** | UploadDO の全失敗終端、in-flight part barrier、DO／D1 の照合優先順位を定義 | §5 の状態機械表 |
| **P0** | 失敗・削除待ち blob を含む物理容量台帳を統一 | D-07 |
| **P0** | 全 operand／upload／job／idempotency の認可と、ticket の用途・node 対応を固定 | A-01〜A-03 |
| **P0** | WebDAV の lock creator、mount alias、LOCK対commit、URI再利用 ETag を修正 | W-01〜W-04 |
| **P1** | client thumb を node 単位の権限境界に分離 | D-10 |
| **P1** | ZIP の出力形式・API呼出数予算を修正し、metadata／配信／転送／生成の累積上限を設定 | C-01〜C-05 |
| **P1** | outbox と backup journal の実際の遷移・保持・修復契約を定義 | §5 の状態機械表 |
| **P1** | public multipart route、DAV認証、quota精算箇所の文書矛盾を解消 | §6 |

## 最終判定

**このまま実装へ渡せるか：No。**

限定的な Foundation の検証は進められます。しかし、現状の「実装契約」を固定して Files core、purge、GC、共有配信を本実装に渡すべきではありません。

ラウンド1の重要な方向転換は成功しています。ラウンド2で必要なのは機能追加ではなく、**「どの状態で、誰が、何を原子的に決定し、その後の古い処理をどう無害化するか」を確定すること**です。
