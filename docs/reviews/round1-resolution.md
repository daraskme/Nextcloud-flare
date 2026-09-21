# Astra ラウンド1 指摘対応表

対象: `docs/DESIGN.md` v0.2

- Blocker 15件、Major 17件、Minor 16件を全件追跡する。
- 「採用」は v0.2 の設計契約へ反映済み、「後段」は安全な v1 制限を置いたうえで v1.1 以降へ送ることを示す。

## Blocker

| ID | 反映箇所（章番号） | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| B-01 | §3, §5, §6, §11 | 採用 | node と不変 blob を分離し、新 key 書込後に期待 revision 付き D1 参照切替を確定点とした。 |
| B-02 | §0, §3, §11, §14, §15 | 採用 | D1 を名前空間等の正本とし、日次 export、Time Travel、GC pause、7日猶予 ledger を定義した。 |
| B-03 | §3, §5 | 採用 | 実体 root、非 NULL parent、case-insensitive 一意性、owner・種類・循環・深さ制約を追加した。 |
| B-04 | §3, §5, §6, §8 | 採用 | `reserved_bytes` の条件付き予約、実サイズ照合、state による一度だけの確定・解放を追加した。 |
| B-05 | §3, §8, §11 | 採用 | `trash_ops` / `deleted_op_id`、既削除子の分離、manifest purge、共有の非自動復活を定義した。 |
| B-06 | §1, §5, §7 | 採用 | LockDO を保存先 owner space 単位にし、全書込みを lock-aware `fsMutation` へ集約した。 |
| B-07 | §3, §6, §15 | 採用 | UploadDO SQLite の状態機械、part 永続化、complete / abort 調停、操作 ID 冪等性を定義した。 |
| B-08 | §4, §5, §6, §8 | 採用 | principal 型、操作許可表、capability subtree、upload-only 制約、共通 `authorize` を追加した。 |
| B-09 | §2, §5, §14, §15 | 採用 | 公開 API を `/api/v1/public/*` に統一し、route manifest、404 境界、未認証 smoke test を追加した。 |
| B-10 | §4, §7, §8, §10, §13 | 採用 | REST、DAV、SSR form の CSRF を分離し、landing / preview / content の CSP 境界を分けた。 |
| B-11 | §0, §6, §13, §15 | 採用 | zone plan 依存、MB/MiB、95 MB / 64 MiB / 500 GiB、10,000 parts、長さ不明 411 を明記した。 |
| B-12 | §10, §13, §15, §18 | 採用 | Images 20 MB、WASM 8 MiB / 12 MP、事前 header 判定、無条件 fallback 禁止を定義した。 |
| B-13 | §5, §13, §18 | 採用（ZIP64 は後段） | v1 ZIP を総量・単体 4 GiB 未満、65,000件以下に制限し、backpressure と path 正規化を追加した。 |
| B-14 | §11, §14 | 採用 | `SUN` / UTC、D1 lease + fencing、cursor/checkpoint 付き冪等 job に置換した。 |
| B-15 | §4, §14 | 採用 | 必須 `OWNER_EMAILS`、fail closed、signup 既定 false、owner 移譲と最後の owner 保護を追加した。 |

## Major

| ID | 反映箇所（章番号） | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| M-01 | §3, §5, §11, §12, §13 | 採用 | batch を bind 100、SQL 長、時間で分割し、keyset、索引、primary read 方針を定義した。 |
| M-02 | §1, §3, §7 | 採用 | KV path cache を非権威化し、`space_generation` と primary 再検証、再帰 CTE を採用した。 |
| M-03 | §3, §5, §7 | 採用 | metadata revision と content ETag を分離し、collection revision と 412 条件を定義した。 |
| M-04 | §3, §5 | 採用 | same-owner COW、cross-owner get→put、固定 manifest の folder COPY を採用した。 |
| M-05 | §7 | 採用 | PROPFIND/PROPPATCH/LOCK/If/Destination/status/XML 上限と protocol error mapping を仕様化した。 |
| M-06 | §0, §6, §7, §17 | 採用（CLI は後段） | UI multipart と通常 DAV の上限を分離し、Nextcloud 完全互換を非目標とした。 |
| M-07 | §3, §5, §10, §14 | 採用 | 世代付き Queue payload / key、outbox、current blob 検証、repair、DLQ API を追加した。 |
| M-08 | §6, §9 | 採用 | IndexedDB、File System Access / 再選択、fingerprint、Web Worker incremental hash を定義した。 |
| M-09 | §3, §12, §15, §18 | 採用 | 専用 `node_search`、NFKC/casefold/かな統一、bigram 候補＋順序照合、1文字 fallback を追加した。 |
| M-10 | §3, §4, §8 | 採用 | app secret は HMAC、共有 password は salt + versioned PBKDF2、先行 rate limit とした。 |
| M-11 | §3, §4 | 採用 | iss+sub identity、email 自動結合禁止、disabled user、完全 JWT 検証、service mapping を追加した。 |
| M-12 | §8, §10, §11 | 採用 | 保護 share の汎用 OG、share version Cookie、no-store / 短期 cache、復元時非再有効化を定義した。 |
| M-13 | §4, §8, §10, §13 | 採用 | content 別 origin、文脈 escape、client thumb の write / 世代 / 形式検査、EXIF 除去を追加した。 |
| M-14 | §11, §13, §14 | 採用 | node/blob/API/time 別予算、checkpoint、backlog / oldest / reclaimed metrics、週次全走査とした。 |
| M-15 | §3, §7, §15 | 採用 | portable name、sidecar 保存、case-insensitive、予約 Shared、安定 mount ID を定義した。 |
| M-16 | §13, §14, §17 | 採用 | 監査 threat model・保持/archive、mask、CSV 対策、監視、単価×想定量の費用表を追加した。 |
| M-17 | §15 | 採用 | 指定された障害境界 13 項目をそのまま release gate にし、実 cloud staging 実測を追加した。 |

## Minor

| ID | 反映箇所（章番号） | 採用・不採用・後段 | 一言 |
|---|---|---|---|
| m-01 | §2, §14 | 採用 | SPA output を `packages/web/dist` に統一し、`pnpm-workspace.yaml` を構成へ追加した。 |
| m-02 | §3, §9 | 採用 | starred を `user_node_state` へ移した。 |
| m-03 | §3, §9 | 採用 | recent を `last_opened_at` として分離し、更新を間引く。 |
| m-04 | §3, §10 | 採用 | thumb の status / source を分離し、`dominant_color` を追加した。 |
| m-05 | §5, §6 | 採用 | upload 作成予約と生 body の `/content` PUT を分離した。 |
| m-06 | §5, §8, §10 | 採用 | internal share、public receive、client thumb の endpoint を API 表へ追加した。 |
| m-07 | §5, §9 | 採用 | bulk job ID、部分結果、cancel、進捗、retry、Idempotency-Key を共通化した。 |
| m-08 | §5, §9, §11 | 採用 | replace / skip / rename、restore 先、大規模破壊操作の確認 UX を定義した。 |
| m-09 | §9, §15 | 採用 | virtual list a11y、touch、低性能端末、upload 中離脱を受入条件へ追加した。 |
| m-10 | §9 | 採用 | PWA を shell cache のみにし、logout 時の browser / query cache 消去を追加した。 |
| m-11 | §0, §9 | 採用 | Google IdP 例外を限定し、外部 font / avatar CDN を禁止した。 |
| m-12 | §14 | 採用 | 正式 `ratelimits` 設定へ変更し、`unsafe.bindings` を禁止した。 |
| m-13 | §14 | 採用 | Access audience / team domain を vars、鍵類を secrets に分類した。 |
| m-14 | §1, §14 | 採用 | Images binding 有り / 無しの environment を分離した。 |
| m-15 | §14, §15 | 採用 | dev/staging/prod resources を分離し、本番 `DEV_BYPASS_ACCESS` を CI / 起動失敗にした。 |
| m-16 | §16 | 採用 | Foundation の gate に認可表、状態機械、blob 世代、予約 quota を入れた。 |

## 「不足している機能・考慮漏れ」対応

| 項目 | 反映箇所 | 判定 |
|---|---|---|
| ファイル履歴と上書き復旧 | §3, §11, §17 | v1 内部保持 / v1.1 UI |
| 同期衝突の扱い | §0, §3, §5, §17 | v1 |
| 差分同期・変更トークン | §17, §18 | v1.1 |
| mtime・checksum の互換 | §3, §6, §7, §17 | v1 |
| チームフォルダ・グループ共有 | §17, §18 | v1.1 |
| 共有の受領・辞退・再共有 | §8, §17 | v1.1 |
| 公開受け取りの運用 | §6, §8, §17 | v1 制限 / v1.1 通知 |
| アプリ資格情報の管理 | §3, §4, §17 | v1 |
| ユーザー停止・削除・移譲 | §4, §17 | v1 |
| インポート／エクスポート | §0, §11, §17 | v1.1（運用 backup は v1） |
| 大量操作の進捗 | §3, §5, §9, §17 | v1 |
| フォルダ情報 | §3, §17 | v1 非同期集計 |
| 実用的な検索 | §12, §17 | v1 基本 / v1.1 保存済み検索 / 本文・OCR 非目標 |
| 通知・アクティビティ | §8, §13, §17 | v1 activity / v1.1 app 内通知 |
| マルウェア・濫用対策 | §8, §10, §13, §17 | malware 検査は非目標、上限・形式検査は v1 |
| データ所在地・管理者閲覧 | §11, §13, §17 | v1（R2 jurisdiction と監査） |
| バックアップ保証 | §11, §17 | v1、RPO 24h / RTO 手動 |

## 旧 §17 回答と制限値表

| 対象 | 反映箇所 | 結論 |
|---|---|---|
| 17-1 不透明 key | §3, §11, §18.1 | 採用。D1 を正本、直接 bucket 操作禁止。 |
| 17-2 WebDAV 認証 | §4, §7, §18.1 | v1 DAV は app password Basic のみ。Service Token は任意の REST 自動化へ分離。 |
| 17-3 日本語 bigram | §12, §15, §18 | 候補抽出として採用、実効上限は staging。 |
| 17-4 PDF / 動画 thumb | §9, §10, §18.1 | client best-effort、未生成を正常系。 |
| 17-5 100 GB 級 | §0, §6, §15, §18.1 | Web UI multipart は対応、通常 DAV は 95 MB。 |
| 17-6 download_count | §8, §18.1 | download ticket 発行数。 |
| 17-7 Access Bypass | §2, §14, §15, §18.1 | 中央認証に route / domain / asset / deploy test を追加。 |
| Cloudflare 制限値表 | §13.1 | review の全行を更新値・要確認事項ごとに反映。 |
