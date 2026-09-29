# 読み取り専用公開リンク

更新: 2026-09-29。

## 実装範囲

Files UI の所有者は、自分が所有する live node を root にした期限付き link share を作成・一覧・参照・無効化できる。作成時だけ `/s/<shareId>#<secret>` を返す。D1 には capability の SHA-256 digest だけを保存し、再表示しない。現在の上限は所有者あたり active 100件、期限は1〜365日（既定30日）。

public landing は fragment を JSON body で unlock API へ送り、直後に history から除去する。成功時は share ごとの `Secure; HttpOnly; SameSite=Lax; Path=/` Cookie を発行する。raw Cookie は保存せず、`share_sessions.secret_digest` に digest を保存する。有効期限は share 期限と7日の短い方である。

public session は各 request で次を再検査する。

- owner と share root の live ancestry。
- share disabled/expiry/version。
- session revoked/expiry/epoch。
- ControlDO mirror の current epoch と maintenance。
- share action と、選択 root 配下の node coverage。

接続済み public API は次の8経路である。

- `POST /api/v1/public/shares/:shareId/unlock`
- `GET /api/v1/public/shares/:shareId`
- `GET /api/v1/public/shares/:shareId/children/:nodeId`
- `POST /api/v1/public/shares/:shareId/csrf`
- `POST /api/v1/public/shares/:shareId/logout`
- `POST /api/v1/public/shares/:shareId/tickets`
- `DELETE /api/v1/public/shares/:shareId/tickets/:ticketId`
- `POST /api/v1/public/shares/:shareId/content-session`

public mutation は app origin、`Origin`、Fetch Metadata、JSON、public 専用 CSRF、share/session の現行性を検査する。logout は share session と派生 content session を失効し、active budget を revoke する。

file 選択時は share root 配下の file だけを target manifest に固定し、share session の期限内で短命 content ticket を発行する。browser は分離された `CONTENT_ORIGIN/session` で ticket を HttpOnly content Cookie に交換してから `/c/<nodeId>/<blobId>` を開く。R2 key は client へ返さない。content origin は D1 authority、manifest、share version/epoch/action、現在の blob、BudgetDO lease を再検査して immutable R2 object を配信する。同じ unlock session の再発行は同じ budget を再利用し、ticket cancel は派生 content session も失効する。

## assets と cache

public shell は `/s` と `/s/:shareId` だけを no-store で返す。JS/CSS は private SPA と別 Vite entry から content hash 付き `/public-assets/*` へ出力し、生成 manifest の完全一致だけを immutable cache で配信する。private `/private-assets/*` と相互参照しない。

## 未接続

app origin の直接 content proxy、password share、upload-only share、内部共有、shared DAV、ZIP、Gallery、Bookshelf、Audio と public media/library route は未接続であり、route registry は 404 fail closed を維持する。remote migration と staging/production deploy は実施していない。

## ローカル検証

- capability の正誤、Cookie 属性、metadata/children、root 外拒否。
- share 間 Cookie 分離、version/epoch mismatch、CSRF logout と失効。
- public ticket の CSRF、root coverage、target manifest、content Cookie 交換、budget 再利用、R2配信、ticket cancel 後の拒否。
- owner 以外の作成/参照/無効化拒否、無効化の一度だけの version 更新と派生 session 失効。
- hashed public assets、private assets 非参照、shell no-store、asset immutable cache。
- route registry の exact allowlist と未実装 route の fail closed。
