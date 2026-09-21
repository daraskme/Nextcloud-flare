# 実装ステータス

## 到達 Phase

Phase 0（成立性検証）完了。

## Phase 0 の確定事項

- `@cloudflare/vitest-pool-workers` の D1 binding で、`changes()` が直前 statement の変更行数を返すことを確認した。
- `_assert` の CHECK 違反により、G01 の node revision 不一致、tree generation 不一致、trash root revision 不一致の全反例で batch の副作用がゼロになることを確認した。
- 主方式には `changes()` 直後 barrier を採用する。
- EXISTS fallback は採用しない。fallback が必要になった場合は後条件だけではなく、更新前条件と更新後条件の両方を必須とする。
- statement error / 明示的 batch rejection は `rollback-confirmed`、network / timeout は `commit-unknown` に分類する。
- R2 known-length stream、single Range、`crypto.DigestStream`、STORE ZIP の同一 serializer による dry-run size、slow consumer backpressure、cancel propagation をローカル Workers runtime で確認した。
- PBKDF2-SHA256 100,000 回を Workers runtime で受理し、Images input の 20,000,000 byte 境界を unit test に固定した。

## 未実装

- Phase 1 以降の migration、認証、認可、台帳、permit、実 mutation、Files、upload、trash/GC、search/share、WebDAV、Gallery、Bookshelf、Audio。
- Cloudflare Access、実 Images binding、実 Cloudflare D1/R2、Queues、Cron、DO eviction を使う staging smoke。
- UI は build pipeline 確認用の最小 shell のみ。
- README と release support matrix。

## 既知の欠陥・制約

- Durable Objects、Queue consumer、Cron は binding/build 検証用 placeholder であり、機能を fail closed にしている。
- ローカル integration runtime の compatibility date は、公開 7 日経過済み test pool が同梱する runtime 上限に合わせて `2026-08-13`。deploy 設定の `2026-09-21` は Wrangler dry-run で検証済みだが、同日 runtime による integration test は staging gate に残る。
- Images はローカルで実変換できないため、入力サイズ境界だけを検証して機能を閉じている。
- PBKDF2 の production 相当 CPU/並列予算は staging 未検証であり、600,000 回への引き上げは行わない。

## 次に着手すべき点

Phase 1 を Brief §8 #10 の順序どおり、contracts → complete migration と FK graph test → ControlDO epoch/R2 history → auth/sessions → quota/ref/pin ledger → permits/LockDO → fsMutation create/outbox の順で実装する。

## 設計へのフィードバック

- Phase 0 時点で安全性契約との矛盾は見つかっていない。
- 現行 Workers runtime では `DigestStream` の実体は `crypto.DigestStream` にあり、型 package の global `DigestStream` 宣言とは配置が異なる。実装は runtime の実体を明示的に使用している。
