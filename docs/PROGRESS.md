# 開発進捗

更新日: 2026-09-24。製品全体は開発中で、productionへのdeploy・migrationは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、所有フォルダーの件数・容量集計まで接続済み。
- 集計機能のcommitは`26c4d07c4877c3f4493f579467b70dd38c2b0e28`。`origin/main`へpush済み。
- ローカル全checkはNode 389件・workerd 800件、別途browser 19件、合計1,208件成功。lint・型・契約・schema・build・Wrangler dry-runも成功。
- 同commitの[CI run 35926517271](https://github.com/daraskme/Nextcloud-flare/actions/runs/35926517271)はUbuntu・Windows・browserの全job成功。Windowsの試験期限調整後の結果も確認済み。

## 今回の変更

失敗した分割uploadの完全回収・容量精算へ進むため、既存のfresh nonceによるR2/S3対応検証を未知IDの回収へ接続した。停止・GC pause中に毎回検証し、claim・一覧保存・abort receipt・後続dispatch・physical観測を同じcurrent proof fenceで保護する。保存済みの成功booleanは利用しない。

誤bucket・旧nonce・期限切れ・応答喪失の境界を追加し、既存の復旧試験を実ControlDO経路へ統合した。関連100件と追加2件は成功。最終`pnpm check`はNode 389件・workerd 811件、計1,200件成功（workerd 380.36秒）。lint・型・契約・設定・schema・Web build・Wrangler dry-runも成功。今回のbrowser試験はpush後のCIで確認する。

未知create/completeの遅延、upload行自体の喪失、全handleの不在証明は未解決。空一覧・時間経過・個別abort成功だけで容量予約を解放しない。実S3のstaging検証も残る。

## 後続の主要項目

- multipart全体閉鎖・容量精算、upload行喪失時のinventory。
- account全体のmutation/KDF制限、残るQueue/repair。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの実配信・再生。
- backup/restore、実Cloudflare環境の設定・負荷・障害試験、公開。

分野別の詳細は[CURRENT_STATE](CURRENT_STATE.md)、実装と検証履歴は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、再開手順は[HANDOFF](HANDOFF.md)を参照。
