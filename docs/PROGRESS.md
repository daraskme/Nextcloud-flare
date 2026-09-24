# 開発進捗

更新日: 2026-09-24。製品全体は開発中で、productionへのdeploy・migrationは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、所有フォルダーの件数・容量集計まで接続済み。
- 未追跡multipartの走査・中止receipt・part容量保留を接続済み。全体閉鎖と容量精算は残る。
- 直前commit `026f534e402cd710742364f9492c773df6b2a657`はpush済み。[CI run35993638387](https://github.com/daraskme/Nextcloud-flare/actions/runs/35993638387)のUbuntu・Windows・browser全job成功。Node389 + workerd857 + browser19 = **1,265件**。

## 今回の変更

アプリパスワードの発行・認証・鍵更新を、ControlDO/D1の全体KDF制限へ接続した。計算の前に試行を保存し、600受付/65秒と未精算20枠を上限とする。通常の単一ControlDO内では1件ずつ実行する。元のpassword・pepper・計算結果は台帳に保存しない。

同じ試行は再実行せず、claim応答喪失では計算を始めない。取消し・期限経過だけで実行枠を戻さず、実際の計算終了後に精算する。精算が不明なら枠を保持し、復旧再開を止める。epoch復旧後の65秒cooldownと、HTTPでの再試行可能な503も接続した。[KDF_ADMISSION](KDF_ADMISSION.md)に契約と限界を記載。

全check成功: Node396件 + workerd877件 = **1,273件**。lint・型・契約・設定・schema・Web build・Wrangler dry-runも成功。新規workerd20件の最終再検証も成功。browser19件も成功し、合計**1,292件**。migration `0029`で通常66table。既存migration・依存は変更していない。

## 後続の主要項目

- KDF未精算のrepair、account mutation制限、残るQueue/repair、backup barrier。
- 未知create/part/completeを含むmultipart全体閉鎖・容量精算、実S3/lifecycle検証。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの実配信・再生。
- backup/restore、実CloudflareのCPU・処理量・負荷・障害試験、WebDAV実client、公開。

詳細は[CURRENT_STATE](CURRENT_STATE.md)、検証履歴は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、再開手順は[HANDOFF](HANDOFF.md)。全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9に従う。
