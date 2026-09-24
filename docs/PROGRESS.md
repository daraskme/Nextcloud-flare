# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commit f9dffcbはmainへプッシュ済み。[CI36032527567](https://github.com/daraskme/Nextcloud-flare/actions/runs/36032527567)はUbuntu・Windows・browser全成功。Node416/workerd1227/browser19、計1,662件。

## 今回の変更

UploadDOの台帳初期化・通常の台帳反映・停止時の反映・台帳喪失時の停止を共通受付へ接続しました。初期化と通常反映は現在の利用者認可、停止反映と喪失処理は復旧用system受付を使い、すべて同じ32 active/256 waiting枠を共有します。

初期化markerや部品送信につながる台帳反映は、D1 batchの直接ACKがなければローカル台帳を確定せず、送信許可も返しません。混雑・rollback・応答喪失でもdirty行、アラーム、予約容量を保持します。台帳全喪失では停止記録を回収できても再初期化しません。

workerd33件追加。新規台帳境界29件と実ControlDO12件が成功。全体checkはNode416/workerd1260、計1,676件が成功し、lint・型・契約・設定・Web build・Worker dry-runも通過。今回のCIはpush後に確認する。schema0033/通常67table、migration・依存追加なし。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

- 自動回収/GC・Queue等の更新受付とbackup barrier。
- 未知KDF/multipartの全体閉鎖・容量精算、実S3/lifecycle。
- 共有・公開link、media metadata、Gallery/Bookshelf/Audio、AVIF/AV1/Opusの配信・再生。
- backup/restore、実Cloudflare負荷・障害試験、WebDAV実client、公開。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
