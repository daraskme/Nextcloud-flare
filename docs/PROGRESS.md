# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commitb971f01はmainへプッシュ済み。[CI36048664003](https://github.com/daraskme/Nextcloud-flare/actions/runs/36048664003)はUbuntu・Windows・browserすべて成功しました。Node422/workerd1593/browser19、計2,034件を確認済みです。Ubuntu5分43秒、Windows17分17秒、browser2分20秒。以前Windowsで失敗したmultipart試験も今回は成功しました。今回のorphan受付はまだ含まれません。

## 今回の変更

未追跡の完成済みR2 objectの調査・回収を共通global受付へ接続しました。scanのclaim・外部予算・観測・ページ保存・lease返却と、GCのclaim・外部予算・置換観測・削除確定・エラー記録が通常操作と同じ32 active/256 waiting枠を使います。

owner不在でもscopeは明示nullで、架空のspaceを作りません。待機後にepoch/mode/pause、元のtoken・60秒lease、object世代・全catalogueからの独立を再検査します。LIST・HEAD・deleteは各回の直接ACKが必要で、既定20秒/最大25秒の開始期限を受付後とACK後に確認します。DB-onlyの確定記録と既存の厳密なtoken/終端照合を維持し、他の処理の完了で自分の未確定枠を返しません。35日猶予・後日owner復元・不在確認後だけのphysical精算を維持し、ControlDO内部は同じinstanceの受付を使います。

workerd105件追加（境界93件・実ControlDO12件）。全体check成功、Node422件（25file、6.01s）・workerd1,698件（81file、888.73s）、計2,120件。lint・型検査・契約/設定検査・Web build・Worker dry-runも成功。schema0034/通常67table、migration・依存追加なし。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[MUTATION_ADMISSION](MUTATION_ADMISSION.md)。

## 後続の主要項目

全bucket multipart inventory・旧epoch repairの残る更新受付とbackup barrier、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
