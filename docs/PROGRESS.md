# 開発進捗

更新日: 2026-09-24。製品全体は開発中で、productionへのdeploy・migrationは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、所有フォルダーの件数・容量集計まで接続済み。
- 未追跡multipartの走査・中止receipt・part容量保留を接続済み。全体閉鎖と容量精算は残る。
- 直前commit `4dbafdd2a1f096bae901c8d00b8eaa6ababfe286`はpush済み。[CI run35997960544](https://github.com/daraskme/Nextcloud-flare/actions/runs/35997960544)のUbuntu・Windows・browser全job成功。Node396 + workerd877 + browser19 = **1,292件**。

## 今回の変更

KDFの送信前の枠と実終了の記録をControlDO SQLiteに最大20件保存し、D1への精算が失敗した場合に再照合する処理を追加した。次の受付前の照合と、停止中の内部repair RPCへ接続した。元epochの終了記録も修復できるが、終了が不明な記録は維持し、復旧監査と再開を拒否する。

新規14件でローカル記録・D1の応答喪失、再起動、遅延claim、重複repair、容量制限、未知試行の保持を検証した。全checkはNode396 + workerd891 = **1,287件**成功。型・契約・設定・ビルドも成功。今回のCI/browserはpush後に確認する。新規D1 migration・依存変更はなく、0029/通常66tableを維持する。[KDF_ADMISSION](KDF_ADMISSION.md)に契約と限界を記載。

## 後続の主要項目

- 終了証明のないKDFの運用収束、account mutation制限、残るQueue/repair、backup barrier。
- 未知create/part/completeを含むmultipart全体閉鎖・容量精算、実S3/lifecycle検証。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの実配信・再生。
- backup/restore、実CloudflareのCPU・処理量・負荷・障害試験、WebDAV実client、公開。

詳細は[CURRENT_STATE](CURRENT_STATE.md)、検証履歴は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、再開手順は[HANDOFF](HANDOFF.md)。全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9に従う。
