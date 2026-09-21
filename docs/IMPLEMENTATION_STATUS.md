# 実装進捗

更新: 2026-09-22。設計 v0.6 + IMPLEMENTATION_BRIEF §8 を実装契約とする。

## 今回の実装

| 項目 | 成果物 / 実証内容 | 状態 |
|---|---|---|
| 0.1 toolchain | Node/pnpm/TS/Wrangler/Vitest/fflate を exact 固定、pnpm lockfile、公開日証拠 `toolchain.json`、CI | ローカル実装済み |
| 0.1 binding | 全 Env binding、SQLite DO の eviction 後の永続化、未実装 route は fail closed、未処理 Queue は retry | ローカル実装済み |
| 0.1 KDF/Images | PBKDF2-SHA256 100,000/16B/32B を OpenSSL の vector と照合。PNG→WebP。20,000,000B/寸法/40MP のアプリ入力境界 | ローカル実装済み、実サービス gate は未完了 |
| 0.2 D1 barrier | `changes()` の直前 statement 性、CHECK rollback、G01 node/tree/trash、全8必須 step の zero-row 注入、前後 EXISTS fallback | workerd D1 で実証 |
| 0.2 outcome | 例外の分類、commit 後の応答喪失を注入して primary で terminal を照合、最大3回/5秒、未確定503 | ローカル実装済み |
| R6 #2 の probe | expired-open/revoked/released/wrong-space permit、old epoch、失効/期限切れ session、disabled actor | 最小 fixture で実証。全 principal 認可は Phase 1 |
| 0.3 streams | FixedLengthStream + DigestStream を直列供給。0B/3B/95,000,000B、長短 mismatch、R2 条件不成立、slow consumer/cancel | ローカル実装済み |
| 0.3 Range | R2 部分取得、HTTP probe の206/416/HEAD/304、suffix/open-ended/多重 Range の正規化 | ローカル実装済み |
| 0.3 ZIP | 同一 fflate STORE serializer の metadata dry-run、CRC vector、Unicode、0/1,000 entries、ZIP32 上限、bounded queue、cancel | ローカル実装済み |
| 1.1 契約・schema | 53通常テーブル + FTS、147経路、scope/operation catalogue、FK index/削除順の生成、tree/terminal/session/accounting guards | migration と基盤契約を追加。全機能の状態遷移・認可は未完了 |
| 1.1 primary adapter | Sessions API を避け、全 authority query を直接 D1 binding へ発行 | 修正・回帰確認済み |
| R6 #4 epoch | SQLite pending→R2 history→D1 mirror→公開、eviction/storage loss、例外後の照合、単一 ControlDO | ローカル実装済み。admission/quiesce/再開は未完了 |
| R6 #3 session | fingerprint 一意登録、logout tombstone、同 user の content session 失効、job chunk の current-credential assertion | JWT verifier/内部 login に接続済み。HTTP 経路は未接続 |
| R6 #5/#6 schema | revoked scope detach、削除中 blob 復帰禁止、single upload 全49遷移の検証 | DB 制約を実証。purge/upload の実サービスは未実装 |
| 1 auth/JWKS | jose exact、固定 issuer/AUD、user/service 分離、KV1h・既知 stale24h、single-flight/rate/鍵数/size/timeout 上限 | Node/workerd 検証済み。rate は isolate 単位、実 Access/MFA policy gate は未完了 |
| 1 bootstrap | allowlist、初回 admin/space/root の atomic CAS、競合/rollback/応答喪失、暗黙 signup 禁止 | ローカル D1 で実証 |
| 1 node authorize | EffectiveLive、4 principal の scope/root/grant/current credential、commit 時 revision/tree/epoch assertion | read/create/automation 4 operation の内部基盤。全 operation の認可は未完了 |
| R6 #7 CSRF | session 束縛 HMAC、TTL1h、再利用・再発行、purpose/aud/epoch/credential、current session/share、Origin 境界 | 内部サービスと D1 テスト実装済み。HTTP profile 接続待ち |
| 1 quota/ref/pin | owner/share reservation、unique logical、R2 HEAD physical、ref≤1,000、pin-only除外、各再送の一度だけ計上 | migration/内部サービス実装済み。GC/repair/namespace mutation 接続待ち |

`packages/worker/test/fixtures/d1-schema.sql` は最小 probe schema であり、本番 migration ではない。
`src/db` と `src/platform` の基盤コードも公開 route には接続していない。
ControlDO は内部 RPC の epoch 発行・復旧を実装したが、maintenance / GC pause を解除しない。
LockDO/UploadDO/BudgetDO は引き続き拒否実装。実装契約・残る境界は [`FOUNDATION.md`](FOUNDATION.md) を参照。

## Toolchain の判断

- 選定日 2026-09-21、公開日 cutoff 2026-09-14 00:00 UTC。直接依存の registry 証拠は `docs/toolchain.json`。
- jose 6.2.12 は2026-09-22に追加選定、公開日2026-09-05で既存 cutoff も満たす。Node/workerd の署名検証に使用。
- `pnpm-workspace.yaml` の `minimumReleaseAge: 10080` で推移依存にも7日の公開期間を要求。
- 使用する `@cloudflare/vitest-pool-workers@0.22.0` は Vitest 4 の `cloudflareTest` API。旧 `defineWorkersConfig` は使わない。
- pool 同梱 workerd が 2026-08-15 のため、compatibility_date を同日へ固定。設計の例示値 2026-09-21 を設定して黙って古い runtime に fallback させない。staging もこの値で検証し、更新時に gate を再実行する。
- Wrangler 自体は4.131.1、同梱 workerd は2026-09-11。staging でのランタイム差は未検証。
- pnpm 12 の `allowBuilds` を使用し、esbuild/workerd の install script だけを許可。
- 公式参照: [Workers tests](https://developers.cloudflare.com/workers/testing/vitest-integration/)、[FixedLengthStream](https://developers.cloudflare.com/workers/runtime-apis/streams/transformstream/)、[DigestStream](https://developers.cloudflare.com/workers/runtime-apis/web-crypto/)、[R2 binding](https://developers.cloudflare.com/r2/api/workers/workers-api-reference/)。依存の実際の API は固定した package の型定義とも照合した。

## 未完了の gate / 次の実装

1. 承認された staging inventory で全 binding/環境 marker/Access を照合し、実 D1 で同じ SQL barrier を再実行する。今回の「応答喪失」は commit 後の fault injection であり実ネットワーク断ではない。
2. Images 実サービスの20MB境界・codec・dimension、KDF CPU/cost、R2転送/キャンセルを計測する。ローカル Images は Miniflare 実装なので料金やサービス限界の証拠にしない。
3. Phase 1 残り: 全 operation tuple の authorize → permit/LockDO → fsMutation/create/outbox/repair。ControlDO admission/再開と HTTP surface/CSRF の接続も必要。
4. R6 §8 の残りの fixture と仕様 v0.7 反映を Phase 1 内で閉じる。Files core/upload/trash/GC の本実装は Phase 1 gate 後。

## M/U/I/R と復旧

- **M**: `0001`〜`0005` を追加し、隔離 D1 と SQLite へ適用して FK/CHECK/trigger/FTS/会計を確認。リモート DB は未変更。probe schema は別 test file に隔離。
- **U**: Node の Range/Images 入力/長さ/commit分類・期限/SQLite テスト。
- **I**: Windows のローカル workerd binding テスト。初回 CI の Windows 改行失敗を `.gitattributes` で修正し、[ec8729d の CI](https://github.com/daraskme/Nextcloud-flare/actions/runs/35623582169) は Windows/Ubuntu 両方で成功（270 tests 時点）。
- **R**: 本番状態を変更していないため production rollback は N/A。依存更新の rollback は manifests/lockfile/toolchain記録を同じ版へ戻して frozen install。テスト R2 object は test 内の finally で削除する。
- 開発 state の破棄は dev 停止後に、このリポジトリ配下の `.wrangler/state` だけを対象として行う。実行前に絶対パスを確認する。staging/production の state や既存 bucket を削除しない。

## 実行記録

- 2026-09-22、Windows / Node 24.21.0 / pnpm 12.4.1 で `pnpm check` 成功。
- Biome、TypeScript、contracts/config verifier: 成功。
- Node 単体: 7 files / 141 tests 成功。
- ローカル Workers 統合: 13 files / 154 tests 成功（合計295 tests）。
- Vite build と Wrangler deploy **dry-run**: 成功。配備や remote migration は実行していない。
- Windows sandbox 内で esbuild の親 directory 読取りが拒否されたため、テストと dry-run build は承認された制限外プロセスで実行。Cloudflare の本番資格情報は使用していない。
