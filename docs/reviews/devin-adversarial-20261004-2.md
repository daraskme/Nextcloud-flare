# Devin 敵対的レビュー・検証 第2回（2026-10-04）

対象: `main` `143f4ec`（PR #41 の H1–H4/M1–M6/L1 修正、#40、#42 取り込み後）。方法: `pnpm check` 全段実行 + 前回修正の再攻撃 + 実コードでの probe テスト。

## 検証結果

- `pnpm check` の unit 段で `scripts/test/backup-encrypted-archive.test.mjs` が 1 件失敗（単体再実行では成功、フレーク）。原因と修正は F2。
- main 上で integration 129 files / 2,416 件 + R2 短尺 1 件（未処理 Promise 0）、Web build + wrangler deploy dry-run 成功。
- 修正後: lint 599 files、typecheck（worker/fault/web）、unit 89 files / 1,033 件（8 skip）成功。`zip-download` + `content-budget` 統合 11 件成功。新しい回帰テストは修正前のコードで失敗する（課金 167 byte、期待 172 byte）。

## 指摘（検証済み）

### F1（MEDIUM・M3 の残存）中央ディレクトリを含む小さな tail Range で ZIP 全体を R2 から読ませられる

PR #41 の sparse Range は、データ記述子（DD）または中央ディレクトリ（CD）レコードを含む entry について CRC が必要なため、その entry を全量 `bucket.get` する（`zipRangeSpans` の `needsCrc`）。一方 budget の reserve/settle は配信した `range.length` だけを課金していた。CD はすべての entry の CRC を含むので、`Range: bytes=-<CD+EOCD のサイズ>`（entry 数 × (46+名前長) + 22 byte 程度）だけで archive 内の全 blob を全量読みさせられ、課金は数 KB で済む。M3 の「1 byte で ~4 GiB」を「CD サイズで ~4 GiB」に縮めただけで、増幅は残っていた。

probe（統合テスト、2 entry の fixture）で実測:

| Range | 応答 | R2 読み |
|---|---|---|
| `bytes=-22`（EOCD のみ） | 206、22 byte | なし |
| `bytes=-60` | 206、60 byte | 2 個目の blob を全量 |
| `bytes=-145`（CD+EOCD） | 206、145 byte | 両 blob を全量（range 指定なし） |

修正: 配信しないのに読む byte（`needsCrc` entry の未配信分。framing 不一致で全直列化に落ちる場合は `outputSize - range.length`）を `undeliveredReads` で算出し、reserve に加算、配信が始まった settle にも加算する。CD を読ませると、その分の budget（target 合計の 3 倍）を消費するようになる。回帰テスト `charges the undelivered whole-entry reads a central-directory range requires` で、tail 145 byte が 145+3+2 byte、EOCD 22 byte が 22 byte で課金されることを確認する。

CRC を blob ごとに D1 に保存すれば全量読みそのものを無くせるが、スキーマ変更になるので今回は課金側で塞いだ。

### F2（LOW・テストのフレーク）`interrupted temp cleanup ...` が同一ミリ秒書き込みで落ちる

`cleanupArchiveTemps(file, 0)` は `item.mtimeMs > Date.now() - 0` の temp をスキップする。`mtimeMs` はミリ秒未満の精度を持ち、`Date.now()` は整数ミリ秒なので、同じミリ秒内に書いた temp は「未来」と判定されて削除されない（`pnpm check` の並列負荷で再現、単体では通る）。実装は正しく、テストの前提が誤り。テストで 3 ファイルの mtime を 60 秒前にしてから呼ぶよう修正。

### F3（MEDIUM・M2 の残存、修正済み: 0063）admission の公平性が space 単位で、principal 単位ではない

`0061_admission_fairness.sql` は非 system の waiting を space ごと 64・全体 224 に制限した。ただし:
- ユーザー 1 人に space は 1 つ（`bootstrap.ts`/`invites.ts`）なので、4 アカウントで 224 枠を埋められ、全ユーザーの非 system mutation が `mutation_unavailable` になる（system 用 32 枠は守られる）。
- internal share の受領者による mutation は owner の `space_id` で数えるため、編集権限のある受領者 1 人が owner 本人の space 枠（64）を埋められる。

修正（`0063_admission_principal_fairness.sql`）: admission に actor（`u:<user>` / `s:<link share>`）と課金 account を記録し、actor ごと16・account ごと32・link share は owner ごと合計16・owner 以外は 1 space あたり48（owner 用に16を確保）の waiting 上限を足した。actor が NULL の行（旧行・owner 暗黙）は owner として数える。多数アカウントによる sybil は招待制のアカウント作成に依存する。

## 前回修正の再攻撃で棄却した候補

- `target_set_nodes` にバックフィルがない件: 移行前の target set は trash 時に取り消されないが、ticket は最大 600 秒。blob 読み（`blobRead.ts`）と ZIP plan（`zipDownload.ts` の再帰 CTE）は配信時に `deleted_at IS NULL` を再確認するので、削除済み内容は出ない。
- DLQ の `failDeadLetteredTreeJob` が live lease で `retry` し続ける件: lease 期限切れ後は guard を通って fail する。DLQ の `max_retries` を使い切った後も、`failExhaustedTreeJob` が残る。
- settlement handover（0060）: 引き継ぎは lease 期限切れ・同一 epoch の proven run に限られる。同じ run による再 claim は従来通り。
- L1 の path 打ち切り: link share と bound app_password と非 owner user のいずれも、ancestor 列内で最も深い有効な share root から切る。覆う root が無い場合は leaf のみ返す。
- 0062 の derived-key tombstone: owner を導出できないキーは `r2_key` の CHECK（`u/` 接頭辞必須）で入らない。導出できる行は collector の due に入る。
- #42 のファイル単体共有のタブ制御: view の初期値は files 固定で、URL から gallery/audio を強制する経路は無い。
