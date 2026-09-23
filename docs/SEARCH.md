# フォルダー配下の検索

更新: 2026-09-24。ローカル実装・検証の記録。リモート配備は未実施。

## HTTP と画面

Access 認証の `GET /api/v1/search?scopeId=<folder>&q=<text>&cursor=<optional>` を接続した。`scopeId` は root または folder。scope 自身を除いた子孫を検索し、名前順で最大200件、次ページの署名 cursor と `truncated` を返す。結果には元の `parentId` があり、検索結果からの上書きも元の保存先を使う。保存場所へ移動する操作も追加した。

Files の検索欄は Enter または「検索」で送信する。「検索を終了」で通常の一覧に戻る。ごみ箱の欄は従来の表示済み項目の絞り込みを維持する。検索範囲にはサブフォルダーも含むこと、結果が一部であることを画面に表示する。次ページ取得中の更新競合や認証拒否では古い結果を隠し、先頭から読み直す。ページ移動とログアウトでは検索状態を解除する。

## 現行の認可

`search.read` の専用 node proof を使い、Access user、現在の session/credential、owner または生きた internal read grant、root までの祖先、epoch、maintenance、対象 revision と tree generation を検査する。最終 assertion と結果 SELECT は同じ D1 batch に置く。app password、service、anonymous/public share の検索 API は接続しない。

子孫の走査は同じ space/owner の生きた親子関係だけをたどる。削除した祖先を越えず、共有範囲外の祖先名・候補数・順位を返さない。検索結果のページ順は `name_ci,id` で固定し、全索引の文書統計に依存する BM25 順位は使わない。無権限の文書が増えても、検索範囲内の順位や cursor が変わらないためである。

cursor は検索専用の署名用途を持ち、正規化後の query、索引 version、scope/space/owner、user/credential、epoch、tree generation、最後の名前と ID に結び付ける。有効期限は10分。他用途・他条件への流用、改変、古い世代は409。query/parameter 不正は400、認可拒否は404、署名設定欠落は503。応答は `private, no-store`。

## 正規化と文字列一致

保存名と query は共通の NFKC、Unicode 17 casefold、カタカナからひらがなへの正規化を使う。query はファイル名ではないため、予約名や記号をファイル名規則で拒否しない。制御文字・不正 surrogate・空語を拒否し、入力と正規化結果を各256 UTF-8 bytes以内にする。

SQLite の [unicode61 tokenizer](https://www.sqlite.org/fts5.html#unicode61_tokenizer) は Unicode 6.1 の文字分類を使う。新しい文字・絵文字・記号の bigram を無条件に MATCH へ渡すと、存在する文字列も候補にできない。既知の token 文字範囲に収まる bigram だけを quote して AND 連結し、最後に `%`・`_`・`\` を escape した LIKE で正規化文字列の部分一致を確認する。FTS は候補生成だけである。

利用可能な bigram がない一文字・記号・絵文字等は、同じ認可済み scope 内の LIKE に切り替える。escape 後の pattern は50 bytes以内。global scan は行わない。範囲や文字列の上限を超えれば検索語を短くするよう案内する。索引の `normalization_version` が古い・欠落した行は結果から除外し、完全な検索結果とせず `truncated:true` にする。

## 走査とページの上限

`services/search.ts` の SQL は、子1件・次の兄弟1件・親へ戻る1件を索引でたどる。通常の recursive CTE へ全 sibling を投入すると LIMIT より先に大きな待ち行列を作るため、この successor walk を使う。最大10,000 node、上下移動は最大20,000 step、space root からの絶対 depth は64以内。scope と候補の CTE にも `LIMIT 10000` を置く。

scope を確定してから、各索引 rowid に限定した FTS lookup を行う。無権限の候補を global MATCH で先に集めない。LIKE で最終照合し、201件目を次ページの有無に使う。scope/candidate が上限に達するか索引が不足する場合、`truncated:true`。確定した総件数や facet は返さない。

## 名前索引の更新番号

`search_index.revision` は最後に検索テキストを更新した node revision。子の追加は親の node revision を進めるが親の名前は変えない。従来の rename/move が両者の一致を要求して失敗する問題を、実 createFolder 後の操作で再現した。

名前を更新する batch は現在の node proof を検査し、既存 FTS の旧値 delete、現在名からの索引更新、新 FTS insert を原子的に行う。索引の revision が認可した node revision 以下なら更新でき、未来の revision や索引の欠落は拒否する。同期処理の rollback と現行権限・tree fence は維持する。

## 検証と残る範囲

Node は正規化、literal query、fallback、byte 上限、cursor 用途/期限/改変を検証する。workerd は実 D1 の階層・200件 keyset・scope10,000上限・他 owner・削除祖先・internal grant・待機中失効・旧索引と rename/move の同期を検証する。ブラウザーは実 API の検索・保存先保持・上書き・再検索・201件 pagination・世代競合と認証拒否を確認する。件数と最終結果は [IMPLEMENTATION_STATUS](IMPLEMENTATION_STATUS.md) を参照。

現在の索引入力は名前。media metadata の parser/同期、検索索引 version の再構築運用、共有管理画面、要求時の bounded stats、実 D1 の rows_read≤20,000/duration≤250ms と負荷試験は残る。ローカルの fixture 件数や所要時間を実 D1 の予算合格とは扱わない。D1 migration・依存追加はない。
