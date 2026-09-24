# 開発進捗

更新日: 2026-09-25。製品全体は開発中。

## 確定した到達点

Files基本操作、単一/分割upload、確認付き上書き・再開、trash/restore/purge、検索、フォルダー集計を接続済み。認証・会計・復旧・共通更新受付とKDF全体制限を実装しています。

直前commit101a7bbはmainへプッシュ済み。[CI36060684164](https://github.com/daraskme/Nextcloud-flare/actions/runs/36060684164)はUbuntu（5m）・browser（1m50s）成功。WindowsもNode422件・workerd1,898件（1,705.00s）とbuild/dry-runを通過しましたが、終了処理中にジョブの30分上限でcancelledになりました。今回、Windowsの統合テストを2 shardへ分割し、各shardのlint/型/契約/設定/Node/build検証とUbuntu・browserを維持しています。分割後のWindows成功は次のCIで確認します。

## 今回の変更

WebDAV PUTの保存前に予約・staging blob・転送台帳を原子的に保存し、保存結果が不明でも容量を保持する処理を実装しました。保存事実と公開失敗後の精算は、実ownerの共通32 active/256 waiting枠を通ります。

migration0035でprivate/DAVの台帳種別を固定しました。開始batchの直接ACK後だけ、attempt metadata付きの条件付きPUTを1回送信します。同じoperationへの再送は追加PUTを発行せず、ストリーム障害時もnative処理の終了を待ちます。成功時は物理計上・hashを保存してからファイルと転送完了を同時確定します。既知の公開失敗はphysicalを保持してGCへ渡し、未知の保存結果は予約を24時間保持してHEAD確認・既存回収へ引き継ぎます。旧DAVの追跡不能な予約も汎用復旧では解放しません。

Node2件・workerd47件を追加。全体実行はNode424件（25file、6.25s）・workerd1,944/1,945件（91file、1,010.68s）成功。唯一の失敗は移行数の旧期待値34で、35へ修正後に実D1のschema5件（2.71s）が全成功しました。ローカル計2,369件を検証済みです。最終lint・型・契約/設定・Web build・Worker dry-runも成功。Windows分割は実Vitestの91fileを46/45fileへ重複・欠落なしと確認し、CIでの実行結果は別途確認します。schema0035/通常67table、依存追加なし。 詳細は[IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md)と[DAV_UPLOAD](DAV_UPLOAD.md)。

## 後続の主要項目

DAVの長い転送と短い公開用permitの分離、旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。

全体の完成条件は[IMPLEMENTATION_BRIEF](IMPLEMENTATION_BRIEF.md)のPhase 0〜9を維持する。remote migration・deployは未実施。
