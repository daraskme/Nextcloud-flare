# DAV PUTの保存台帳

更新: 2026-09-25。

WebDAV PUTの保存前に予約・staging blob・転送台帳を原子的に保存し、保存結果が不明でも容量を保持する処理を実装しました。保存事実と公開失敗後の精算は、実ownerの共通32 active/256 waiting枠を通ります。

migration0035でprivate/DAVの台帳種別を固定しました。開始batchの直接ACK後だけ、attempt metadata付きの条件付きPUTを1回送信します。同じoperationへの再送は追加PUTを発行せず、ストリーム障害時もnative処理の終了を待ちます。成功時は物理計上・hashを保存してからファイルと転送完了を同時確定します。既知の公開失敗はphysicalを保持してGCへ渡し、未知の保存結果は予約を24時間保持してHEAD確認・既存回収へ引き継ぎます。旧DAVの追跡不能な予約も汎用復旧では解放しません。

## 送信と公開

migration0035はuploads.sourceをprivate/DAVで固定し、既存行はprivateとして維持する。DAV行は実app_password credential・dav.put operation・owner/space・parent/target・request digest・予約のop_id/size/epoch/expiryへ束縛する。private upload capabilityは発行しない。台帳IDはdav_ + operation ID、blob/reservationのIDは元のDAV契約を維持する。

開始batchは現在のnamespace permit/operation/認可を検査し、24h予約・staging blob・receiving台帳・不変のwrite attemptと15分leaseを保存する。同じIDの競合/ACK喪失は送信許可にならない。conditional-onlyIf PUTとmetadataを必須とし、consumeKnownLengthでproducer/consumer/digestの終了を全て待つ。未確定の同一operationは現在の認可を確認してcommit_unknownとして再照会し、本文を再送しない。HTTP再試行は別request IDとなる。

実PUTの成功応答からsize/metadata/etagとhashを検証し、system:dav.put-stored受付でphysical charge・hash・completing/in_flight=0・自分の確定記録を一つのbatchへ保存する。permitやcredentialが失効しても内部の保存事実は必要になる。通常公開の認可は別途現在の状態を検査する。namespaceは保存済みphysical/hashを原子的に照合し、create10/overwrite8 stepのうち従来のblob_storage markerをupload完了markerに置き換える。node/version/outbox/予約消費/blob公開/台帳完了は同時確定する。

## 失敗と回収

既知のfailed operationかつ完成bodyの証明がある場合だけsystem:dav.put-failed受付で予約を解放する。元のupload/owner/credential/epoch/attempt・operation operand/step不在・physical proofを待機後に再検査し、同じbatchでorphanとGC candidateを保存する。他のcleanup_tokenが有効ならGCへ割り込まない。R2をinline deleteせず、physicalはGCの実削除/不在確認まで維持する。混雑時には保留し、既知終端の元namespace permitは返す。

失敗精算済みの終端は読取りだけで返す。共通確定記録を失った場合も厳密な元の終端を照合できるが、他処理の結果で自分のunknown枠を明示解放しない。GC後・全32枠占有・ControlDO eviction後も追加受付なしで再照会する。

receivingのままのbody/PUT応答喪失は、operationがfailedでも予約を解放しない。期限前のHEAD absentは終了証明にならない。24時間後、既存single cleanupがDAV由来を照合してHEADを実行し、presentはphysical計上を保ってGC、absentは容量解放へ収束する。metadata不一致は計上・隔離し、committed operationやoperation stepがあれば回収しない。旧DAVのupload台帳がない予約も汎用旧epoch修復から除外し、証拠不足のまま返さない。

## 検証と残作業

Node2件・workerd47件を追加。全体実行はNode424件（25file、6.25s）・workerd1,944/1,945件（91file、1,010.68s）成功。唯一の失敗は移行数の旧期待値34で、35へ修正後に実D1のschema5件（2.71s）が全成功しました。ローカル計2,369件を検証済みです。最終lint・型・契約/設定・Web build・Worker dry-runも成功。Windows分割は実Vitestの91fileを46/45fileへ重複・欠落なしと確認し、CIでの実行結果は別途確認します。schema0035/通常67table、依存追加なし。

試験は0B/create/overwrite/版/outbox、送信前の台帳、同じIDの並行再送、stream/nativeの終了順、開始/保存事実/精算/namespaceのACK喪失、primary照合不能、grant後のepoch/mode/receipt/op/step競合、実ControlDO共有枠・eviction、期限後のHEAD/GC、旧予約の保留、private API分離、forward migrationを検査する。

この実装でも本文の前にnamespace permitを取得し、その有効期間は既存の30秒である。長い転送は保存を失わず保留・回収できるが、長時間PUTの正常な公開を満たすには、本文転送を短い公開用permitから分離する必要がある。これは次の実装項目であり、DAV全体の完成とは扱わない。

DAVの長い転送と短い公開用permitの分離、旧DAV保留の証明付き回収、backup barrierとlogical export/restore drill、未知KDF/multipartの収束、追加event処理、共有・公開link、Gallery/Bookshelf/Audio、AVIF/AV1/Opus、実環境検証・公開は後続です。
