あなたは「この設計を壊すこと」を任務とする敵対的レビュアー（red team）です。Cloudflare Workers / R2 / D1 / Durable Objects / Queues の実装経験と、WebDAV・分散ストレージ・Web セキュリティに精通しています。

対象: `docs/DESIGN.md` (v0.2 — ラウンド1 の指摘を反映済み)。参考: `docs/reviews/round1-astra.md`（前回レビュー）、`docs/reviews/round1-resolution.md`（反映表）。ファイルは編集しないでください（レビュー結果のみ出力）。

## 依頼: ラウンド2 — 敵対的レビュー

以下の観点で、**具体的な攻撃/障害シナリオを手順付きで**列挙し、設計がそれに耐えるか判定してください。「一般論」ではなく、この設計書の記述（章番号・テーブル名・API 名）を引用して、成立する経路を示すこと。

1. **データ破壊・不整合シナリオ**: 並行 PUT / MOVE / DELETE / restore / complete / GC / purge の交錯で、blob を失う・別人の内容が見える・revision が巻き戻る・quota が壊れる経路はあるか。各シナリオを「前提状態 → 操作列 → 結果 → 設計のどの規定が防ぐか／防げないか」で書く。
2. **認可バイパス**: link share の capability を越えて祖先/兄弟/他人のノードに到達できるか。upload-only で列挙・上書きができるか。app password の scope を越えられるか。Access Bypass 経路から private API に到達できるか。共有 Cookie/ticket の再利用・偽造・ダウングレード。IDOR（node_id / blob_id / upload_id / share_id / job_id の推測・混在）。
3. **WebDAV 特有**: 悪意ある/バグのあるクライアントから、ロックの横取り・永久ロック・他 space のロック、`Destination` ヘッダによる SSRF/跨ぎ移動、XML 爆弾、PROPPATCH による protected property 改変、`If:` ヘッダ評価の穴、パス正規化の二重デコード。
4. **DoS / コスト攻撃**: 公開共有・upload-only・WebDAV 経由で D1 rows read/written、R2 Class A/B 操作、Images 変換、DO 実行時間、Queue メッセージ数を膨らませる経路。1 リクエストで最も高コストになる操作は何で、上限はあるか。
5. **状態機械の穴**: UploadDO / trash_ops / gc_candidates / job_leases / outbox の遷移で、到達不能・二重確定・永久 pending・fencing 抜けになる遷移。
6. **前回反映の検証**: `round1-resolution.md` の「採用」項目が本当に設計本文に反映され、矛盾していないかを抜き取り検査（最低 10 項目）。反映漏れ・自己矛盾・数値の不整合を列挙。
7. **判定**: 各シナリオに `致命 / 重大 / 中 / 低` と「実装前に直すべき / 実装時に注意 / 受容可」を付け、最後に「このまま実装へ渡せるか（Yes / 条件付き / No）」と、No/条件付きの場合の必須修正リストを出す。

出力は日本語の Markdown。Cloudflare の制限値・仕様で確信がないものは「要確認」と明記してください。
