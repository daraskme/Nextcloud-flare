# 実装ステータス

## 到達 Phase

Phase 1（Foundation）完了。

## Phase 0 の確定事項

- `@cloudflare/vitest-pool-workers` の D1 binding で、`changes()` が直前 statement の変更行数を返すことを確認した。
- `_assert` の CHECK 違反により、G01 の node revision 不一致、tree generation 不一致、trash root revision 不一致の全反例で batch の副作用がゼロになることを確認した。
- 主方式には `changes()` 直後 barrier を採用する。
- EXISTS fallback は採用しない。fallback が必要になった場合は後条件だけではなく、更新前条件と更新後条件の両方を必須とする。
- statement error / 明示的 batch rejection は `rollback-confirmed`、network / timeout は `commit-unknown` に分類する。
- R2 known-length stream、single Range、`crypto.DigestStream`、STORE ZIP の同一 serializer による dry-run size、slow consumer backpressure、cancel propagation をローカル Workers runtime で確認した。
- PBKDF2-SHA256 100,000 回を Workers runtime で受理し、Images input の 20,000,000 byte 境界を unit test に固定した。

## Phase 1 の実装

- operation、scope、principal、upload state、limit、error の shared contract と完全 Foundation migration を追加した。
- FK graph から purge order を検査し、独立 trash 子の detach、FTS 除外 export、deleting blob の復旧拒否を fixture 化した。
- ControlDO の R2 epoch history、R2/D1 floor、history 書込み後の公開、LockDO の D1-open permit、BudgetDO の耐久 counter を実装した。
- Access session fingerprint、logout による派生 content session revoke、job credential fence、session-bound HMAC CSRF、principal negative matrix を実装した。
- quota reservation、blob pin/ref、operation claim/lookup、outbox claim/ack-loss replay/repair を実装した。
- permit、epoch、D1 時刻 expiry、user/session live、EffectiveLive、revision、tree generation を commit batch で再検査する folder create を実装した。
- route manifest を `packages/worker/src/routes/manifest.ts` に集約し、manifest 外の Hono route が登録されないことを contract test で検証した。
- R6 #1〜#9 の指定 fixture を、後続 phase の transport を開かず contract/Foundation レベルで追加した。

## 未実装

- Phase 2 以降の immutable content、Files core、upload transport、trash/GC/recovery drill、list/search、share/content/ZIP、WebDAV transport、Gallery、Bookshelf、Audio。
- Cloudflare Access JWT/JWKS verifier と HTTP auth adapter。未承認 verifier を推測導入せず、Phase 1 HTTP route は 503 で fail closed にしている。
- app password/share/service の HTTP credential 発行・検証 adapter。schema、principal contract、commit predicate の土台のみ実装済み。
- UploadDO、Queue consumer、Cron は fail-closed placeholder。LockDO の DAV lock graph は Phase 7、BudgetDO の content route 接続は Phase 6 で実装する。
- Cloudflare Access、実 Images binding、実 Cloudflare D1/R2、Queues、Cron、DO placement/eviction を使う staging smoke。
- UI は build pipeline 確認用の最小 shell のみ。
- README と release support matrix。

## 既知の欠陥・制約

- Foundation create の portable name は、安全な version 固定 Unicode casefold 実装が未承認のため printable ASCII subset に限定して fail closed にしている。
- migration rollback は destructive down migration ではなく、maintenance 下の D1 snapshot/Time Travel restore を前提とする。
- ローカル integration runtime の compatibility date は、公開 7 日経過済み test pool が同梱する runtime 上限に合わせて `2026-08-13`。deploy 設定の `2026-09-21` は Wrangler dry-run で検証済みだが、同日 runtime による integration test は staging gate に残る。
- Images はローカルで実変換できないため、入力サイズ境界だけを検証して機能を閉じている。
- PBKDF2 の production 相当 CPU/並列予算は staging 未検証であり、600,000 回への引き上げは行わない。

## 次に着手すべき点

Phase 2 の immutable blob transfer/read を、R2 不変 key、known length、SHA/ETag 分離、EffectiveLive、HEAD/Range、commit-unknown 照合から実装する。その後 create/overwrite/version、rename/MOVE、same-owner COW、folder COPY の順に進む。

## 設計へのフィードバック

- `docs/DESIGN.md` v0.6 の `nodes` CHECK は non-root の `parent_id IS NULL` を常に禁止する一方、Brief §8 #5 は別 trash operation の既削除子を purge 時に `parent_id=NULL` とするよう要求する。§8 を優先し、migration は deleted non-root に限って NULL を許可した。
- DESIGN の CSRF profile は one-time token と記載するが、Brief §8 #7 は session-bound HMAC・TTL 1h・再発行自由を優先する。実装は §8 に従った。
- Brief §8 は upload/BudgetDO/DAV fixture を Phase 1 条件に含める一方、本文 phase 表では各本実装を Phase 3/6/7 に置く。Phase 1 では状態機械・耐久 counter・protocol contract のみを fixture 化し、外部 transport は開いていない。
- 現行 Workers runtime では `DigestStream` の実体は `crypto.DigestStream` にあり、型 package の global `DigestStream` 宣言とは配置が異なる。実装は runtime の実体を明示的に使用している。
