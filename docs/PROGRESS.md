# 開発進捗

更新日: 2026-09-24。製品全体は開発中で、productionへのdeploy・migrationは未実施。

## 確定した到達点

- Filesの基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、名前検索、所有フォルダーの件数・容量集計まで接続済み。
- 既存uploadの未知multipart ID修復は、毎回freshなBLOBS/S3対応検証付きで走査・中止まで接続済み。
- 直前commit `98115609562818498f3c13d530ec6fa2bbf00380`はpush済み。[CI run35954162544](https://github.com/daraskme/Nextcloud-flare/actions/runs/35954162544)のUbuntu・Windows・browser全job成功。Node389 + workerd811、別途browser19件、計1,219件を検証済み。

## 今回の変更

D1のupload行が失われた未完了multipartを、保存先の`u/`全体から発見・記録する内部RPCを追加。part一覧をページ単位で保存し、各partの最大観測容量を所有者のphysical会計へ保留する。縮小・消失・404・応答喪失で減算せず、所有者が後日復元された場合も一度だけ計上する。

毎回freshなBLOBS/S3対応検証と同一batchのfenceを使い、競合するdispatch・二重計上・古いcursorの再利用を防ぐ。0 bytesの隔離handleも復旧再開を止める。migration `0027`で3tableを追加し、合計64通常table。既存migrationと依存は変更していない。

新機能27件とschema5件の関連検証に加え、最終`pnpm check`も成功。Node389 + workerd838 = **1,227件**（23+55 files）、workerd395.26秒。lint・型・契約・設定・schema・Web build・Wrangler dry-run成功。browser19件もCI成功し、計1,246件。詳細は[MULTIPART_BUCKET_INVENTORY](MULTIPART_BUCKET_INVENTORY.md)。

commit `dfd2468`の[CI run35964611990](https://github.com/daraskme/Nextcloud-flare/actions/runs/35964611990)はUbuntu（6分23秒）・browser（19件、2分7秒）成功。Windowsは新機能27件を含む837/838件が成功し、既存の1万件検索fixtureだけ個別60秒でtimeout。個別指定を既存Windows runner予算と同じ90秒へ揃える。検索の1万件上限・アサーション・本番期限は変更しない。 修正後のCIは最新SHAで確認する。

ここでの走査完了・容量保留は、回収完了ではない。記録を失ったhandleの中止、未知create/part/completeの遅延、全handleの閉鎖証明と予約・保留容量の精算は未完了。実S3のstaging検証も残る。

## 後続の主要項目

- multipart全体閉鎖・容量精算、upload行喪失時の中止・修復。
- account全体のmutation/KDF制限、残るQueue/repair。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの実配信・再生。
- backup/restore、実Cloudflare環境の設定・負荷・障害試験、公開。

分野別の詳細は[CURRENT_STATE](CURRENT_STATE.md)、実装と検証履歴は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)、再開手順は[HANDOFF](HANDOFF.md)を参照。
