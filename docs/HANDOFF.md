# 開発の引き継ぎ

更新: 2026-09-29。**コード基準 `81b351e`、今回は資料整理のみ。全体完成ではない。** 現在状態は [CURRENT_STATE](CURRENT_STATE.md)、実行結果の履歴は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、最近の変更は [PROGRESS](PROGRESS.md) を参照する。

## 再開時に把握すること

- migration `0001`〜`0077`、通常81テーブル、152経路の契約。全契約のHTTP接続・全phaseの完成を意味しない。
- 本棚一覧、個人の登録フォルダー、ZIP/CBZページ閲覧、利用者別読書位置、内部／公開共有、同じ所有者内の書籍COPYは接続済み。EPUBはコンテナ索引まで。
- Gallery／Audio／共有管理を未実装とした古い概要は更新済み。残件は [CURRENT_STATE](CURRENT_STATE.md) の表を使う。
- **次の候補は既存／未索引／旧COPY／所有者間COPY先の書籍索引要求。調査のみで、実装はまだない。** 資料更新をこの機能の完成と取り違えない。
- 直近の書籍COPYは関連202件の成功記録あり（Node37・workerd164・Chrome1、複数回の実行と再試験の集計）。最終修正後の試験と先行成功分の内訳はCURRENT_STATE参照。全suite・全browser・最新CI・全復旧ドリルは未確認。
- 資料整理前のローカル追跡参照は `origin/codex/database-restore = 472e682`、基準コードは33コミット先。remote再照会はしていない。資料コミット後の差分数は `git status` で確認する。

## 次に実装する範囲

既存のZIP/CBZ/EPUBに、現在の閲覧権限で索引生成を明示要求する導線を本棚から追加する。新規uploadだけでなく、索引なしのコピー先からも完了を確認し、ZIP/CBZを読める状態につなぐ。

調査先:

| 対象 | 参照先 |
|---|---|
| 現行の索引・配信・COPY契約 | [ARCHIVE_READER](ARCHIVE_READER.md) |
| 明示的な既存media要求 | [MEDIA_EXTRACTION](MEDIA_EXTRACTION.md)、`packages/worker/src/api/mediaExtraction.ts` |
| 原本・公開索引の証明 | `packages/worker/src/services/archiveRead.ts` |
| 同じ所有者内の索引再利用 | `packages/worker/src/services/copyLibrary.ts` |
| Outboxの終端JSON／索引保存schema | `packages/worker/migrations/` の0076／0077 |
| 本棚・共有・公開のHTTPと画面 | `packages/worker/src/api/libraryShelf.ts`、`packages/web/src/public-share/`、`packages/web/src/features/library/` |

既存の `media.extract` / `media.requested` を拡張する案は未確定。generator・重複要求・旧要求・公開済み索引の再利用・未公開PUTの保留契約を確認してから決める。同じblobの保存済み索引を使う場合も、現在の原本・権限・出力receipt・pin・回収状態を検査する。失効した元読者への要求を別読者へ無条件に付け替えず、結果不明の書込みを再送／解放しない。

完了確認には、所有者／内部共有／公開共有、旧ファイルとコピー先、二重要求、原本差替え／権限失効、Queue再配信／応答喪失、索引の二重PUTとphysical二重計上がないこと、本棚→結果確認→閲覧の導線を含める。その後の優先順はCURRENT_STATEを参照する。

## 作業場所と検証

現workspaceは `/home/hiroshi/ドキュメント/Nextcloud-flare`。`/tmp/Nextcloud-flare` は移動前の保管用コピーなので開発先にしない。Windows側の記録は `C:\Users\micro\Documents\Nextcloud-flare`。branchは `codex/database-restore`、remoteは `https://github.com/daraskme/Nextcloud-flare.git`。

```sh
git status --short --branch
git log -5 --oneline
.local-toolchain/run node --version
.local-toolchain/run pnpm --version
```

Node `24.21.0` / pnpm `12.4.1`。`.local-toolchain/` はGit対象外。依存はexact／lockfile固定で、選定証拠は [toolchain.json](toolchain.json)。環境再構築時は `pnpm install --frozen-lockfile` を使う。

```sh
.local-toolchain/run pnpm check
.local-toolchain/run pnpm test:browser
.local-toolchain/run pnpm test:browser:single-host
.local-toolchain/run pnpm backup:drill
.local-toolchain/run pnpm backup:operator-drill
.local-toolchain/run pnpm backup:run-drill
```

- 上記は今後の検証コマンドで、今回全てを実行済みという意味ではない。`check` はlint・型・契約／設定・Node／workerd・build。browserとbackupドリルは別。
- 変更に対応する試験を選ぶ。全体確認ではソースを固定し、native workerd・build・browser・operatorドリルを同時実行しない。試験中にソースやfixtureを書き換えない。
- この環境ではnative/build/browser/drillとGit書込みにsandbox外実行が必要になる場合がある。browserはPTYで実行する。承認拒否をlock残骸と誤認して `.git/index.lock` を消さない。
- `test-results` は次のbrowser実行で上書きされる。必要な失敗／成功artifactは先に保存する。workspace→`/tmp` は別filesystemの場合があるので、renameではなくコピーする。
- `pnpm build` はWeb buildとWrangler dry-run、`pnpm dev` はローカルbinding。全0のresource IDを実IDとして使わない。初期のControlDO受付停止をflag直書きで解除しない。
- Git authorが必要なら既存commitの値を確認してper-command設定を使い、global設定は変更しない。
- schema変更は新migrationとfixture／生成契約をそろえ、`node scripts/generate-schema-contracts.mjs` を実行する。適用済みmigrationは書き換えない。

## 保持する不変条件

- D1はnamespace・認可・台帳、R2は不変content、ControlDOは復旧外の単調epoch／停止状態の正本。mutationの認可・epoch・permit・revision/tree・terminalを同じ原子的境界で照合する。
- `commit_unknown` を失敗と推測してnamespaceを補償しない。DB-onlyのreceipt回収と、外部I/Oを許可する直接ACKを混同しない。
- GCの `deleting` は不可逆。参照・pin・epoch・claimをdispatch／精算時に再検査し、物理不在の確認前にphysicalを減らさない。
- 未知KDF／R2／multipartをHEAD・TTL・空一覧だけで終了としない。予約・holdを推測で外さない。ControlDO再開は全監査と最終fenceを通す。
- 公開bundleへprivate client／秘密値を入れない。JWT・lock token等をログしない。
- AVIF・AV1・Opusの必須対応と [MEDIA_FORMATS](MEDIA_FORMATS.md) の検証条件を維持する。最終完了条件は [IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md) と [DESIGN](DESIGN.md)。

## 許可・未実施の操作

ローカル実装・検証・切りのよい通常commitを継続する。pushは先行の自動承認審査で「外部宛先へのコード送信の明示承認がない」と拒否され、`daraskme/Nextcloud-flare` の `codex/database-restore` への宛先確認が未回答のため保留。後続commitへの差替えで再試行しない。force pushはしない。

remote Cloudflareのresource作成・migration・secret設定・配備・実受付再開は未実施。GitHub pushの許可をCloudflare配備の許可とみなさない。必要な実環境情報を確定するまでは、ローカルの実装・検証を進める。

## 資料更新

本書には再開に必要な現在の情報だけを置く。検証記録と過去CIはIMPLEMENTATION_STATUSへ、機能別の状態はCURRENT_STATEへ記載する。整理前の全文が必要なら `git show 81b351e:docs/HANDOFF.md` 等で取得できる。
