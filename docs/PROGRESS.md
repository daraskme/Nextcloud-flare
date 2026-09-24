# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commit9cbc24cはmainへプッシュ済み。[CI36057631001](https://github.com/daraskme/Nextcloud-flare/actions/runs/36057631001)はUbuntu（6m27s）・Windows（21m41s）・browser（2m9s）の全job成功。両OSでNode422/workerd1,847、browser19件、計2,288件を確認しました。WindowsのKDF統合20件（6.861s）も成功。今回の公開失敗後の精算受付はまだ含まれません。

## 今回の変更

単一・分割uploadで公開operationの失敗が確定した後の精算を共通system受付へ接続しました。実際の所有spaceで通常操作と同じ32 active/256 waiting枠を取得し、upload・blob・予約解放・確定記録を一つのbatchで保存します。

待機後に元のupload/owner/space/credential/epoch/予約と失敗operationのoperand・step不在を再検査します。最初の予約解放には一致するblob_storageの物理計上を必須とし、singleは検証済みhash、multipartは独立した完成object proofを要求します。公開結果不明・転送中・参照済みblob・証拠不足では解放しません。精算済み結果は追加受付なしで読み、GC後も再照会できます。応答喪失は自分の確定記録または厳密な終端を照合し、他の精算で自分の未確定枠を返しません。混雑はHTTP503/Retry-Afterで予約とphysicalを保留し、再試行でR2送信・削除を繰り返しません。

workerd51件を追加（境界46件・実ControlDO4件・HTTP1件）。関連109件（66.06s）と実ControlDO4件に加え、全体checkが成功。Node422件（25file、6.20s）・workerd1,898件（87file、990.88s）、計2,320件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[UPLOAD_FAILED_COMPLETION](UPLOAD_FAILED_COMPLETION.md)。

## 後続の主要項目

DAV PUT失敗後の精算・不明な保存結果の保留、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
