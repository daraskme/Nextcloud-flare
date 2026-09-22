# セッション引き継ぎ

更新: 2026-09-22。次のセッションはこの資料から開始する。実際の `git status` / `git log` とコードを正とし、過去の会話だけで作業状態を推測しない。

## 目標とユーザーの追加条件

Cloudflare 上のファイル管理アプリを設計の完了条件まで実装する。Foundation のみを完成扱いにしない。
直近の依頼は「完成したところまでコミット・プッシュし、セッションを引き継げるよう資料を整理」。この checkpoint は全体完成ではない。

- 切りのよい単位で検証後に commit / push する。`origin/main` への通常 push はユーザー承認済み。force push はしない。
- ユーザーが事前に **画像 AVIF・動画 AV1・音声 Opus** にエンコードする。保存・配信・Gallery/player を必須対応にする。具体的なコンテナと試験条件は [MEDIA_FORMATS](MEDIA_FORMATS.md)。
- リモート Cloudflare の resource 作成・migration・配備は実行していない。GitHub push の許可を production 配備の許可とみなさない。
- 許可済みの可逆な実装・検証は継続し、必要な情報が足りる作業で確認を挟まない。

## 資料の読み方

1. この資料で直近の状態と再開点を確認する。
2. [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) が実装状況・テスト件数・実行記録の正本。
3. [FOUNDATION](FOUNDATION.md) で変更対象の内部契約だけを読む。
4. [IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) §2 が全 phase の順序、§8 が R6 の確定条件。
5. [DESIGN](DESIGN.md) v0.6 の該当章を参照。R6 は BRIEF §8、メディア追加要件は MEDIA_FORMATS を併読する。

`reviews/` と REVIEW_LOG は判断経緯。通常の再開時に全レビューを読み直す必要はない。

## 現在動いている範囲

Phase 0 のローカル基盤と Phase 1 の一部。53通常テーブル、migration `0001`〜`0010`、147 route の契約がある。
JWT/JWKS、bootstrap、sessions、read/create/rename/content write/automation 認可、CSRF、quota/ref/pin/physical 会計、epoch 復旧、D1 permit、create/rename 用 LockDO、operation claim/lookup を実装済み。

直近の追加: 改名の D1 一括 mutation、`node.renamed` の outbox 消費と旧 epoch 整理、共有と資格情報 scope root の祖先を検証する復旧監査。content ticket の署名、D1 redemption、Cookie 署名、R2 target manifest と current blob 認可を内部サービスとして接続した。直近の検証件数と CI は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) を正とする。監査完了は再開の証明ではなく、ControlDO admission は閉じたまま。

主要な内部成果物（最新状態は進捗表を参照）:

| ファイル | 実装内容 |
|---|---|
| `packages/shared/src/names.ts` | NFC/portable name、Unicode 17 full casefold、folder-name search text/bigram |
| `packages/worker/src/services/fsMutation.ts` | SQL assertion、全 step と terminal の atomic commit、確実な rollback と commit_unknown の分離 |
| `packages/worker/src/services/createFolder.ts` | LockDO/認可/claim/7 step/terminal/release を接続した最初の folder create |
| `packages/worker/src/services/renameNode.ts` | 対象と親の lock、FTS 更新、operation/terminal/outbox を一括確定する改名 |
| `packages/worker/src/services/blobRead.ts` | Cookie→current credential/session/ticket/target manifest/blob plan と BudgetDO reserve/settle 付き R2 immutable blob HEAD/Range 配信基盤 |
| `packages/worker/src/do/BudgetDO.ts` | `budget_id` ごとの SQLite lease/byte/request/parallel counter。公開 fetch は未有効化 |
| `packages/worker/src/services/contentBudget.ts` | principal/share/unlock 単位の安定 budget ID を current D1 認可で確保・再利用。ticket 内部発行サービスに接続済み |
| `packages/worker/src/services/contentTicket.ts` | R2 target manifest の staging と読戻し、現行認可の一括証明、D1 ticket/target set 確定、応答喪失時の照合・object cleanup |
| `packages/worker/src/services/contentTicketCancel.ts` | current credential を照合し、ticket と派生 content session を同一 D1 batch で失効。共有 budget は維持 |
| `packages/worker/src/api/contentTickets.ts` | Access 認証済み private request の CSRF・bounded JSON 検査から ticket 発行/取消へ接続 |
| `packages/worker/src/api/privateApp.ts` / `privateAppConfig.ts` | app host の Access JWT→D1 session→`/me`・CSRF 発行・logout・private ticket handler。必要な issuer/AUD/署名鍵/bootstrap 設定が無ければ 503 |
| `packages/worker/src/api/account.ts` | current credential を再確認する `/me`、CSRF 後の D1 session 失効と Access logout 303 |
| `packages/worker/src/services/nodeRead.ts` / `api/nodes.ts` | current ancestry と maintenance を D1 batch で確認する node 詳細・最大200件の keyset children 一覧 |
| `packages/worker/src/api/nodeMutations.ts` | CSRF と bounded JSON / Idempotency-Key の検査から folder 作成・node rename、確定・競合・結果不明の HTTP 応答、同 credential の operation 照会 |
| `packages/worker/src/auth/nodeCursor.ts` | credential/parent/owner/epoch/tree generation と最終 sort key を10分の専用 HMAC kid ring に束縛 |
| `packages/worker/src/auth/appPassword.ts` | DAV Basic 用の厳密な入力境界、kid 別 pepper + PBKDF2 digest、認証前後の current D1 照合。DAV route と rate limit は未接続 |
| `packages/worker/src/api/content.ts` | content host の ticket 交換/CORS と Cookie 配信 HTTP handler。ControlDO と署名鍵 gate は Worker entry |
| `packages/worker/src/auth/contentTokens.ts` / `contentAccept.ts` | kid ring の HS256 ticket/Cookie と D1 redemption。`content_sessions.ticket_id` は migration `0009` |
| `packages/worker/src/jobs/outbox.ts` | token/lease 付き producer、ID-only send、期限切れ再送、bounded repair scan |
| `packages/worker/src/jobs/consumeOutbox.ts` | create/rename event の current authority、元 operation step、保存済み operand/result を照合する consumer |
| `packages/worker/test/integration/fs-mutation.test.ts` | 全必須 step の rollback、並行再送、応答喪失、失効対 commit |
| `packages/worker/test/integration/outbox.test.ts` | producer 競合、送信/D1 応答喪失、completed の巻戻し拒否 |
| `packages/worker/test/unit/names.test.ts` | Unicode同名・portable禁止・長さ境界・検索正規化 |

直近の test 件数と CI は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) を正とする。checkpoint の commit SHA と最新 CI は下記の Git コマンドで確認する。資料内に self-reference の commit SHA を固定しない。

## 公開・接続していないもの

- content HTTP handler は追加済みだが、ControlDO maintenance と署名鍵未設定で実公開は停止中。他の HTTP 経路は未有効化。SPA は準備用 HTML のみ。147 route の存在は handler の完成を意味しない。
- **ControlDO.status は maintenance=true / gcPaused=true。** `recover`/`bumpEpoch` はあるが、admission/quiesce/検証後の再開は未実装。単純に false に変えない。
- LockDO/create/rename の成功テストは test-only admission と実 DO SQLite/D1 を組み合わせる。実 ControlDO による稼働許可を実証したものではない。
- Queue handler と Cron は ControlDO/D1 admission gate を通過した場合に outbox を処理する。ControlDO が閉じている間は Queue を retry し、Cron は送信しない。実 Queue ack/DLQ の配信試験は未完了。
- UploadDO、Files UI、upload/trash/GC/restore、全 operation の認可 tuple、検索/共有/content/DAV の大部分の HTTP 接続、Gallery/Bookshelf/Audio、運用・release は未完了。private ticket 発行/取消と CSRF の app route は Worker entry に接続したが、実 ControlDO admission とリモート Access/署名鍵設定は未完了。全 route 会計も未接続。
- AVIF/AV1/Opus は形式基盤まで。実 track parser・配信経路・player/lightbox・ブラウザー実ファイル試験は未接続。
- Cloudflare staging inventory/Access/MFA・実 Images codec/費用・実 D1/Queue・backup復旧等の gate は未完了。ローカル成功で代替しない。
- private app route のリモート設定は `ACCESS_ISSUER`、`ACCESS_USER_AUDIENCE`、`ACCESS_SERVICE_AUDIENCE`、`BOOTSTRAP_OWNER_EMAILS`/`BOOTSTRAP_OWNER_IDENTITIES`、`BOOTSTRAP_QUOTA_BYTES`、`CSRF_PRIVATE_KEYS`/`CSRF_PUBLIC_KEYS` と各 active kid、content ticket/Cookie の kid ring。local `wrangler.jsonc` に秘密を置かず、未設定時は 503。
- children 一覧の続きには `NODE_CURSOR_KEYS` と `NODE_CURSOR_ACTIVE_KID` の専用 ring が必要。未設定時も node 詳細は使えるが children route は 503。

## 次に進める順序

1. **outbox Queue 実サービス / repair**: `node.created` と `node.renamed` のローカル handler を基に実 Queue/DLQ/requeue を検証し、残る kind の saved operand/result CAS と chunk fencing を実装する。ControlDO admission が閉じている間は `retryAll` を維持する。
2. **ControlDO admission / resume**: durable な監査進捗へ credential/share/outbox の全意味検証、未知 R2 object の repair と incomplete multipart の扱い、GC/Upload/Queue drain と最終 D1 fence 後の admission 再開を追加する。正本は DO、D1 は mirror。空 DB 専用の解除処理を完成形にしない。
3. **Phase 1 の残り**: 各 operation の operand tuple、HTTP host/profile/CSRF、app-password/share secret 検証、operation lookup/commit_unknown response を接続。R6 §8 の全 fixture と完了条件を現在のテストへ対応付ける。
4. Phase 1 gate を閉じてから BRIEF の後続 phase を順に実装する。メディア形式の追加条件を維持し、最後に実環境 gate とリリース確認を行う。

フォルダー作成は current parent/revision/tree を読み、7 step を一括確定する内部サービス。SQL plan は server code のみで生成し、外部から任意 step/SQL を受け付けない。
現在の検索 helper は folder-name 用。media metadata の全文索引や検索 API が実装済みと扱わない。

## 再開コマンド

作業場所は実環境で確認する。現在の NixOS workspace は `/tmp/Nextcloud-flare`、Windows workspace は `C:\Users\micro\Documents\Nextcloud-flare`。remote: `https://github.com/daraskme/Nextcloud-flare.git`、branch: `main`。

```powershell
git status --short
git log -5 --oneline
gh run list --limit 3 --json databaseId,headSha,status,conclusion,url
node --version
pnpm --version
```

Node 24.21.0 / pnpm 12.4.1。依存は exact、公開後7日以上。`docs/toolchain.json` に選定証拠、`pnpm-lock.yaml` に固定版。
環境の準備が必要なら `pnpm install --frozen-lockfile`、変更後の checkpoint は `pnpm check`。
範囲を絞った検証例:

```powershell
pnpm exec vitest run --config vitest.config.ts packages/worker/test/integration/fs-mutation.test.ts packages/worker/test/integration/outbox.test.ts
pnpm exec vitest run --config vitest.unit.config.ts packages/worker/test/unit/names.test.ts
```

schema 変更時は新 migration を追加し `node scripts/generate-schema-contracts.mjs` を実行する。既存適用済み migration を書き換えず、schema test のテーブル数/適用数も整合させる。
`pnpm build` は Vite + Wrangler **dry-run**。`pnpm dev` もローカル binding のみ。全0の resource ID を実環境の ID として利用しない。

## 環境で分かった注意点

- Windows の sandbox 内で esbuild の親 directory 読取りが拒否される場合がある。既存セッションでは承認された制限外プロセスで pnpm test/check/build を実行した。
- Git の index 書込みと network push に sandbox escalation が必要だった。拒否を lock 残骸と誤認して `.git/index.lock` を削除しない。
- Git author は global 未設定。必要時は `gh api user` と既存 commit の author を確認し、per-command config を使う。既存は `darask` / `102633287+daraskme@users.noreply.github.com`。global 設定は変更していない。
- `.gitattributes` は LF 固定。Windows CI の過去の改行失敗は修正済み。
- Vitest Workers pool 0.22 の intentional RPC rejection は cleanup を停止させることがある。拒否は `runInDurableObject` の内側で捕捉する。成功側を含め、admission fixture と実 RPC の検証範囲を区別する。
- 同梱 workerd の都合で compatibility date は2026-08-15。日付や依存更新は別途 gate を通す。
- ローカル試験の R2/DB fixture と実 inventory は別物。会計 fixture の一部は metadata のみで実 R2 object を作らないため、resume verifier 試験には整合する専用 fixture が必要。
- commit_unknown で namespace を補償しない。単純な `meta.changes` の JS 判定で rollback と判断しない。DO epoch を時刻から生成しない。秘密値・全 JWT・lock token をログしない。
