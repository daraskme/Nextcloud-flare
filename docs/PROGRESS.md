# 開発進捗

更新日: 2026-09-24。製品全体は開発中で、productionへのdeploy・migrationは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、所有フォルダーの件数・容量集計まで接続済み。
- 既存uploadの未知multipart IDは、毎回freshなBLOBS/S3対応検証付きで走査・中止まで接続済み。upload行喪失時の全bucket走査・part容量保留も接続済み。
- 直前commit `284a202930cb95c00c5eea5de7f07706daa52138`はpush済み。[CI run35966922855](https://github.com/daraskme/Nextcloud-flare/actions/runs/35966922855)のUbuntu・Windows・browser全job成功。Node389 + workerd838 + browser19、計1,246件。既存Windows検索/配信lease fixtureのtimeoutも解消済み。

## 今回の変更

発見済みの未追跡multipartを正確なkey/IDで中止し、結果を不変のattempt台帳へ保存する内部RPCを追加。migration `0028`で合計65通常table。稼働中uploadや未満了leaseがあれば送信せず、停止中・一覧走査完了・fresh proofを同じD1確定境界で検査する。

中止要求を送る前にattemptを確定し、同じIDの再送は保存結果だけを返す。保存応答が失われてもR2への二重送信をしない。64件の生涯予算、10秒の待機上限を設け、NoSuchUpload・通信失敗・遅い応答でも容量保留と隔離を維持する。中止の成功履歴だけで容量を戻したり復旧を再開したりしない。契約は[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md)。

新機能19件とschema検証に加え、最終`pnpm check`も成功。Node389 + workerd857 = **1,246件**（23+56 files）、workerd411.79秒。lint・型・契約・設定・Web build・Wrangler dry-runも成功。今回のbrowser/Windows試験はpush後のCIで確認する。詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)。既存migration・依存・本番期限は変更していない。

## 後続の主要項目

- 未知create/part/completeの遅延と完成物を含むmultipart全体閉鎖・容量精算、実S3/lifecycle検証。
- account全体のmutation/KDF制限、残るQueue/repair。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの実配信・再生。
- backup/restore、実Cloudflare環境の設定・負荷・障害試験、公開。

分野別の詳細は[CURRENT_STATE](CURRENT_STATE.md)、実装と検証履歴は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、再開手順は[HANDOFF](HANDOFF.md)を参照。全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9に従い、この中止機能だけで完成扱いにしない。
