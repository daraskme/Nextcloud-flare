# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commit357de9fはmainへプッシュ済み。[CI36054612441](https://github.com/daraskme/Nextcloud-flare/actions/runs/36054612441)はUbuntu（6m19s、Node422/workerd1,780）・browser（2m22s、19件）成功。Windowsは20分のjob上限で中断し、既存KDF並行試験にも1件の失敗が記録されました。追加したbucket関連82件はWindowsでも成功。Windows jobを30分にし、KDF試験は2件ずつ3組で同時1件・全6件の確定記録を検査するよう調整しました。製品の5秒期限・制限は維持し、Windowsの結果は次のCIで確認します。今回の旧epoch修復受付はこの直前CIに含まれません。

## 今回の変更

旧epochの予約解放・Outbox通知の停止・検索索引の再構築を共通受付へ接続しました。予約と通知は実際の所有space、索引再構築は明示null scopeで、通常操作と同じ32 active/256 waiting枠を使います。

修復の前後は従来どおり全更新の停止を要求します。更新batch内だけは自分の有効な受付IDを除外し、他のactive/waiting、permit・claim・job・GC・uploadとbootstrap管理者の条件を待機後に原子的に再検査します。自分の枠が空いても他の更新が残れば修復しません。DB-onlyの確定記録と厳密な終端・索引照合で応答喪失を扱い、他の処理の完了では自分の未確定枠を返しません。uploadへ結び付いた予約は保持し、元の行・所有者・通知のoperation由来を再検査します。予約・通知は1回最大20件、次の更新開始には固定25秒の期限を使い、ControlDO内部は同じinstanceで受け付けます。

workerd67件を追加（境界59件・実ControlDO8件）。追加67件（14.72s）・既存復旧23件（12.96s）と全体checkが成功。Node422件（25file、5.81s）・workerd1,847件（85file、983.56s）、計2,269件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 全体check後にCI試験を調整し、KDF統合20件（7.15s）・待機列Node8件（104ms）・lint・型検査を再確認しました。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

upload公開失敗・DAV PUT失敗後の精算受付、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
