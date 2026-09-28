# WebDAV の内部共有

更新: 2026-09-28。`/dav/Shared/<mount>`へ、内部共有の一覧・閲覧・更新と、同じ所有者の異なる共有間の COPY/MOVE を接続した。所有者をまたぐコピー、実 OS クライアント、staging は後続。製品全体や DAV 全体の完成を意味しない。

## 接続と権限

ルート制限のない app password で `/dav/` を開くと、read scope がある場合は Depth 1 の一覧に `Shared/` が現れる。`/dav/Shared/` は OPTIONS と PROPFIND Depth 0/1 の仮想 collection。ここへの書き込みはできない。ルートを指定して発行した app password は、指定先が個人領域の root であっても Shared を公開しない。

mount は内部共有の作成時に保存した固定名を使い、共有元の rename 後も変わらない。`GET /api/v1/shared-with-me` と同じ対応表である。migration0048以前から存在する `mount_name IS NULL` の共有には名前を推測して補わない。Access の Shared では引き続き使え、所有者が共有を作り直すと固定 DAV mount が付く。

リクエストは mount の share ID/version を選択し、その範囲だけで処理する。COPY/MOVE は転送元と転送先の選択を独立に保存する。root までの祖先、現在の grant・share version・期限・disabled、所有者と受信者の状態、app password の期限・失効・scope、control epoch/maintenance を再検査する。別の広い edit 共有があっても、選んだ共有の失効・read-only を補えない。tagged `If` は選択した転送元・転送先だけを解決し、第三の mount や個人領域への代替は許可しない。

## 対応する操作

| 対象 | 操作 |
|---|---|
| 仮想 Shared | OPTIONS、PROPFIND Depth 0/1。候補上限1,000、超過は507。Depth 0は候補を走査しない |
| 共有の file/folder | OPTIONS、PROPFIND、GET/HEAD/単一Range、MKCOL、PROPPATCH、PUT、LOCK/refresh/UNLOCK |
| 同じ共有内の子 | COPY、MOVE、DELETE。既存の1,000 node/10 GiB転送予算とscopeを維持 |
| 共有 root | MOVE/DELETE/MKCOLを拒否。file rootのPUT上書きは許可し、非公開parentへのアクセスは与えない |
| 同じ所有者の異なるmount間 | COPY/MOVEと上書き。COPYは転送元readと転送先edit、MOVEは両側editを要求 |
| 異なる所有者のspace間 | 現段階は403。受信共有と自分の個人領域とのCOPYはRESTの非同期copy jobで後続。DAVでは自動fallbackせず403を維持。cross-space MOVEは非対応 |

更新は共有の edit と各 app password scope の両方を要する。直接共有された file への PUT は実際の保存名を保持する。HTTP `If-Match` は強いETag一致、`If-None-Match` は弱い比較を使い、DAV `If` と独立に検査する。既存 file のPUTには `If-Match` または `If` が必要。古いETagをヘッダーに置いただけで上書きできる状態を修正した。

共有の PROPFIND は lockroot を mount 内の DAV URL に写し、共有外の祖先に付いた lock は mount root へ写す。その祖先の owner XML、元の display href、生の lock token は返さない。実際の祖先 lock は更新許可の検査に残る。

## 保存・再送・復旧

migration `0050_dav_selected_shares.sql` は既存 operations/uploads の選択pairを app password と source=dav にも許可する。DAV の資格情報を持つ受信者と保存先 owner を分け、選択なしの DAV は従来どおり owner 本人に限定する。既存データ、NULL mount、69通常table、過去の選択なしdigestを維持し、依存は追加しない。

PUT の予約・blob・uploads は owner に計上し、operation actor は受信者を残す。選択pairを operation digest、LockDO の許可intent、upload、R2 write admission、completion、Outbox、再照会と復旧監査へ引き継ぐ。保存後の差替えや不一致の completion は拒否する。共有停止中に native PUT が終わった場合も保存事実と容量保留を残し、namespace 公開は止める。空fileのLOCK作成も owner の R2 prefix を使う。

migration `0051_transfer_destination.sql` は operations に転送先space/share ID/versionを加える。旧記録はNULLのまま旧scopeを使い、新規DAV転送は個人領域も明示する。明示した個人領域はactor本人の所有を要求し、内部共有への暗黙の切替えはしない。二つの権限をclaim・確定・LockDO intent・再送・Outbox・結果照会で検査する。MOVE後のnodeは転送先の選択で照会し、元parentの権限も保持する。確定応答が失われても同じ選択で再照会し、共有停止時は広い別grantで補わない。復旧監査は正常な過去versionを許し、不完全なpair・非整数version・別space・不正な操作種別を拒否する。

0050/0051適用後に選択付き DAV を受け付けたDBを、選択を扱わない旧Workerへ戻さない。rollbackが必要な場合はmaintenanceを保ち、両側の選択情報を理解するWorkerで検証する。remote migration・配備・実OS検証は行っていない。

検証の件数と実行結果は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) に記録する。次はcross-owner copy、公開link/password/unlock/public bundle、upload-only、ZIP、共有media、実環境gateが残る。AccessのShared画面の宛先pickerは同じ共有内に限定したままである。
