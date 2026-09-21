# Migrations

Phase 1 用の forward migrations。`0001` は identity / namespace / ledger、
`0002` は content / media / search、`0003` は不変条件の trigger、
`0004` は機械生成した operation catalogue / FK index。

テストは `readD1Migrations` + `applyD1Migrations` で隔離 D1 に適用する。
既存の Phase 0 probe schema は別 test file の隔離 DB を使い、混在させない。

本番 DB へはまだ適用しない。down migration は提供せず、既存データがある場合の rollback は
maintenance / GC pause / epoch bump を含む承認済み restore 手順で行う。
ローカル開発の空 DB には `pnpm exec wrangler d1 migrations apply DB --local` で適用できる。

FK graph、生成順序、状態遷移、復旧境界は `docs/FOUNDATION.md` を参照。
