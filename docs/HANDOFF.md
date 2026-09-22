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

Phase 0 のローカル基盤と Phase 1 の一部。53通常テーブル、migration `0001`〜`0008`、147 route の契約がある。
JWT/JWKS、bootstrap、sessions、read/create/automation 認可、CSRF、quota/ref/pin/physical 会計、epoch 復旧、D1 permit、create 用 LockDO、operation claim/lookup を実装済み。

今回の追加: `ControlDO.quiesce(expectedEpoch)` で停止側 DO status を確認し、D1 の maintenance/GC pause、permit revoke、claimed operation failed を atomic に収束させる。active job lease を報告し、SQL 障害 rollback を確認した。NixOS の Node 24.20.0 / pnpm 12.3.4 で `pnpm check` **429 tests**（Node 195、workerd 234）と lint/typecheck/contracts/config/build に成功。admission と復旧 verifier/再開は未実装なので ControlDO は引き続き常に停止側を返す。前回の `505c77c` の [CI](https://github.com/daraskme/Nextcloud-flare/actions/runs/35682308736) は成功。

今回の checkpoint で追加したコード:

| ファイル | 実装内容 |
|---|---|
| `packages/shared/src/names.ts` | NFC/portable name、Unicode 17 full casefold、folder-name search text/bigram |
| `packages/worker/src/services/fsMutation.ts` | SQL assertion、全 step と terminal の atomic commit、確実な rollback と commit_unknown の分離 |
| `packages/worker/src/services/createFolder.ts` | LockDO/認可/claim/7 step/terminal/release を接続した最初の folder create |
| `packages/worker/src/jobs/outbox.ts` | token/lease 付き producer、ID-only send、期限切れ再送、bounded repair scan |
| `packages/worker/test/integration/fs-mutation.test.ts` | 全必須 step の rollback、並行再送、応答喪失、失効対 commit |
| `packages/worker/test/integration/outbox.test.ts` | producer 競合、送信/D1 応答喪失、completed の巻戻し拒否 |
| `packages/worker/test/unit/names.test.ts` | Unicode同名・portable禁止・長さ境界・検索正規化 |

直前の `2fd68ac` は AVIF/AV1/Opus の仕様・bounded container sniff・MIME・再生可否 helper（350 tests 時点）。[CI](https://github.com/daraskme/Nextcloud-flare/actions/runs/35629022538) は Windows/Ubuntu とも成功。
前回の Windows checkpoint のローカル `pnpm check` は **415 tests**（Node 195、workerd 220）と lint/typecheck/contracts/config/build が成功。
checkpoint の commit SHA と最新 CI は下記の Git コマンドで確認する。資料内に self-reference の commit SHA を固定しない。

## 公開・接続していないもの

- HTTP は全経路未有効化。binding 不備は503、その他は404。SPA は準備用 HTML のみ。147 route の存在は handler の完成を意味しない。
- **ControlDO.status は maintenance=true / gcPaused=true。** `recover`/`bumpEpoch` はあるが、admission/quiesce/検証後の再開は未実装。単純に false に変えない。
- LockDO/create の成功テストは test-only admission と実 DO SQLite/D1 を組み合わせる。実 ControlDO による稼働許可を実証したものではない。
- Queue handler は `retryAll`、Cron は no-op。outbox producer と `node.created` consumer helper は呼べるが、実 Queue ack/DLQ と他 kind の result CAS は未接続。
- UploadDO/BudgetDO、Files UI、upload/trash/GC/restore、全 operation の認可 tuple、検索/共有/content/DAV、Gallery/Bookshelf/Audio、運用・release は未完了。
- AVIF/AV1/Opus は形式基盤まで。実 track parser・配信経路・player/lightbox・ブラウザー実ファイル試験は未接続。
- Cloudflare staging inventory/Access/MFA・実 Images codec/費用・実 D1/Queue・backup復旧等の gate は未完了。ローカル成功で代替しない。

## 次に進める順序

1. **outbox Queue 接続 / repair**: 現在の `node.created` と ack 判定 helper を基に実 Queue/DLQ/requeue を検証し、他 kind の saved operand/result CAS と chunk fencing を実装する。ControlDO admission が閉じている間は `retryAll` を維持する。
2. **ControlDO admission / resume**: quiesce の active job lease 以外の GC/Upload/Queue drain と、DB/R2/会計/参照/root/credential/outbox の復旧検証を bounded に実装する。正本は DO、D1 は mirror。空 DB 専用の解除処理を完成形にしない。
3. **Phase 1 の残り**: 各 operation の operand tuple、HTTP host/profile/CSRF、app-password/share secret 検証、operation lookup/commit_unknown response を接続。R6 §8 の全 fixture と完了条件を現在のテストへ対応付ける。
4. Phase 1 gate を閉じてから BRIEF の後続 phase を順に実装する。メディア形式の追加条件を維持し、最後に実環境 gate とリリース確認を行う。

フォルダー作成は current parent/revision/tree を読み、7 step を一括確定する内部サービス。SQL plan は server code のみで生成し、外部から任意 step/SQL を受け付けない。
現在の検索 helper は folder-name 用。media metadata の全文索引や検索 API が実装済みと扱わない。

## 再開コマンド

作業場所: `C:\Users\micro\Documents\Nextcloud-flare`。remote: `https://github.com/daraskme/Nextcloud-flare.git`、branch: `main`。

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
