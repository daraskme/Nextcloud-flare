# Migrations

Phase 1 用の forward migrations。`0001` は identity / namespace / ledger、
`0002` は content / media / search、`0003` は不変条件の trigger、
`0004` は機械生成した operation catalogue / FK index。
`0005` は reservation/参照 counter trigger と R2 実在会計行。非0の旧 physical counter は個別 inventory 移行が必要なため拒否する。
`0006` は permit identity と open 一意性。適用前に全 open permit を収束させる。
`0009` は content session を発行元 ticket に束縛する。旧 session 行の `ticket_id` は NULL のまま残り、content read assertion では拒否するため、短い TTL の満了後に cleanup する。
schema contract generator は適用済み migration を再生成せず、今後の catalogue/index 変更も forward migration で追加する。

テストは `readD1Migrations` + `applyD1Migrations` で隔離 D1 に適用する。
既存の Phase 0 probe schema は別 test file の隔離 DB を使い、混在させない。

本番 DB へはまだ適用しない。down migration は提供せず、既存データがある場合の rollback は
maintenance / GC pause / epoch bump を含む承認済み restore 手順で行う。
ローカル開発の空 DB には `pnpm exec wrangler d1 migrations apply DB --local` で適用できる。

FK graph、生成順序、状態遷移、復旧境界は `docs/FOUNDATION.md` を参照。
