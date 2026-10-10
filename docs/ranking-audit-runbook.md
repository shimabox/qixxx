# スコアランキング Free 版(非同期監査)運用手順書

スコアランキング Free 版で採用している非同期監査方式の運用手順。
Paid 版(同期検証)の運用は [`docs/ranking-runbook.md`](./ranking-runbook.md) を参照
(D1 スキーマの基礎・シーズン切替・検証ルール変更はそちらと共通)。

関連ファイル:

- 追加スキーマ: [`migrations/0002_ranking_free_async.sql`](../migrations/0002_ranking_free_async.sql)、[`migrations/0004_ranking_rate_limits.sql`](../migrations/0004_ranking_rate_limits.sql)
- POST ハンドラ: [`functions/api/scores.ts`](../functions/api/scores.ts)
- 監査モードの解釈(`RANKING_AUDIT_MODE`、§7): [`functions/_lib/ranking/auditMode.ts`](../functions/_lib/ranking/auditMode.ts)
- GET ハンドラ: [`functions/api/ranking.ts`](../functions/api/ranking.ts)
- 監査ロジック: [`scripts/audit/runAudit.ts`](../scripts/audit/runAudit.ts)
- 監査ロック: [`scripts/audit/lock.ts`](../scripts/audit/lock.ts)
- D1 接続アダプタ: [`scripts/audit/d1Adapter.ts`](../scripts/audit/d1Adapter.ts)
- CLI エントリポイント: [`scripts/audit/cli.ts`](../scripts/audit/cli.ts)
- launchd 定期実行: [`scripts/audit/launchd/`](../scripts/audit/launchd/)

---

## 0. 全体像

Paid 版との違いは「投稿時に `verifyReplay()` で即座に真偽判定する」か
「投稿は基本検査のみで `pending` 保存し、後続の監査ジョブが確定させる」かの一点。
`verifyReplay()` 自体(スコア導出・終了条件判定・RLE 検証)は完全に同じものを
POST(このブランチでは呼ばない)と監査ジョブの両方で共有する設計。

```
POST /api/scores ─→ ヘッダー検査 + D1 レート制限 ─→ 基本検査 + 圏内事前ゲート ─→ D1 に status='pending' で保存 ─→ 即応答
                                                          │
                                                          ▼
                           scripts/audit/runAudit.ts (Node, 手動 / launchd)
                                                          │
                              verifyPendingEntry() (= verifyReplay() + 申告値/version 突合)
                                                          │
                     ┌────────────────────────────────────┴───────────────────────────────┐
                     ▼                                                                      ▼
        確定的に不合格 → 即削除                                              予期しない例外 → audit_attempts++
   (VerifyReplayResult.ok=false /                                          next_attempt_at で次周期送り
    申告値・version 不一致)                                                  (3回で削除)
                     │
                     ▼
        status='verified' に更新 → TOP10 整理(圏外 verified 行のみ削除)
```

### 0.0 監査あり/なしの2モード(`RANKING_AUDIT_MODE`)

上図は既定の**監査あり**モード。環境変数 `RANKING_AUDIT_MODE=disabled` を設定すると
**監査なし**モードになり、監査の運用(Mac の常時稼働・D1 API トークン・Keychain)なしで
ランキングを動かせる。切替にコード変更は要らない(手順は §7)。

| モード | `RANKING_AUDIT_MODE` | POST の保存 | その後 |
| --- | --- | --- | --- |
| 監査あり(既定) | 未設定・空・`enabled`・それ以外の未知の値 | `status='pending'` | 上図の監査が `verified` へ昇格するか削除する |
| 監査なし | `disabled`(前後の空白と大文字小文字は無視) | `status='verified'` | 監査しない。申告スコアがそのまま確定順位になる |

モードが影響するのは POST の書き込み時点だけ。`GET /api/ranking`・リプレイ取得・監査
スクリプトはモードを知らず、行に保存された `status` だけで動く。このため、切替時に
既存行を自動で変換する仕組みはない(必要な変換は §7 の手順で SQL を流す)。

> **監査なしの間はクライアント申告のスコアを信じる。偽スコアを送れる。偽 10 件で投稿が
> 締め出される**(偽の verified 行が10位閾値を押し上げ、正規の投稿が事前ゲートで
> 「圏外」として保存されなくなる)。**リプレイがスコアと一致する保証がない**
> (POST は `verifyReplay()` を呼ばないので、RLE として復号できる任意の入力列に任意の
> スコアを付けて確定順位に載せられる。再生ボタンはスコアと無関係なリプレイを再生し得る)。

### 0.1 表示契約・72時間境界・リプレイ判定順

**`GET /api/ranking` は2系統を返す**(用途が違うので混同しないこと)。

| フィールド | 中身 | 用途 |
| --- | --- | --- |
| `entries` | verified のみの TOP10(`score DESC, rank_seq ASC`) | **投稿可否判定の唯一の基準**(入力フォームの暫定表示・POST の事前ゲート) |
| `displayEntries` | verified + 新鮮な pending を同じ順位規則で統合した上位10件。各行に `status:"pending"｜"verified"` | **表示専用**。事前ゲートにも原子的 INSERT にも影響しない |

表示 pending 候補は統合前に `score DESC, rank_seq ASC LIMIT 3` で絞る。
このため `displayEntries` に載る pending は常に最大3件で、verified が7件以上ある
状況では必ず7行以上が verified になる。**偽 pending が表示上位を占めても、
verified 10位を上回る正当な投稿は事前ゲートを通過して受理される**
(妨害防止。`functions/_lib/ranking/mergedBoardIntegration.test.ts` と
`tests/e2e/ranking.spec.ts` の2本立てで担保)。

`POST /api/scores` は `RANKING_IP_HASH_KEY` による HMAC-SHA-256 だけを D1 に保存し、
同一 IP ハッシュにつき1時間固定窓で30回まで受け付ける。31回目以降は
`429 {"error":"rate limit exceeded"}` と固定窓終了までの `Retry-After` を返す。
レート制限 D1 が失敗した場合は KV へフォールバックせず、投稿を fail-closed の 500 にする。
`SHARES` KV は X シェアと `/share` 用に残るが、ランキング投稿は読み書きしない。

**72時間境界の統一定義**: `cutoff = now − 72時間` を全処理で共通に使い、
**新鮮 = `created_at > cutoff`**、**期限切れ = `created_at <= cutoff`** とする
(実装は `functions/_lib/ranking/pendingGate.ts` の `pendingFreshnessCutoff()` に
一本化。displayEntries 抽出・POST の上限 COUNT・リプレイ判定・監査の期限切れ削除の
4箇所すべてがこれを参照する)。verified はこの判定の対象外。監査は launchd だけが
定期実行し(Mac がスリープしている間の代替実行はない)、72時間という長めの窓は、
監査が一度も走らない期間(Mac がスリープしている間だけ)未検証スコアが長く表示され
得ることと引き換えに、週末をまたいでも投稿者のスコアを失わないための選択である。

**`GET /api/ranking/:id/replay` の判定順**(この順で評価し、最初に該当したものを適用):

1. 行が無い / 監査で削除済み → **404**
2. pending かつ期限切れ → **404**
3. season/ruleset/format が現行と不一致 → **410**(pending・verified を問わない)
4. 上記以外(新鮮な pending、またはバージョン一致の verified) → **200**(`status` 付き)

2 が 3 より先に評価されるため、「期限切れ404」と「バージョン不一致410」は重複しない。

#### 0.1.1 UI は pending と verified を区別しない

公開ランキングは **リアルタイムの順位表**として扱い、pending 行に VERIFYING バッジ
などの印は付けない(X への即時共有とリアルタイム性を優先する判断)。リプレイ
ビューアの VERIFYING 表示も同様に廃止し、X ハンドルは pending/verified とも
リンクにする(監査が検証するのはスコアであってハンドルの所有権ではないため、
監査状態をリンク可否に流用しない。既存の「ハンドルは自己申告」注意書きが責任境界)。

役割分担は次のとおり:

| 相手 | 伝え方 |
| --- | --- |
| 公開ランキングの閲覧者 | 順位表の静的注意書き「Scores may be checked after posting, and entries found invalid may be removed.」で、後から削除され得る運用を常時開示。監査あり/なしのどちらでも正しい中立的な文にしてある(`GET /api/ranking` はモードを返さないので、UI はモードを知らない) |
| 投稿者本人 | 投稿完了時の文言を POST 応答の `status` で出し分ける。`pending` なら「SUBMITTED — PENDING VERIFICATION.」で監査待ちを伝え、`verified`(監査なし)なら「SUBMITTED.」 |
| サーバー・運用 | `displayEntries` / リプレイ応答の `status` は**維持**(監査・削除・デバッグ用。UI は描画に使わない) |

「検証を隠す」のではなく、「各行を疑わしそうに見せず、ランキング全体の運用ルール
として開示する」設計である。偽スコア対策そのもの(表示 pending 上限3件・投稿資格は
verified 基準・監査による削除)は、この表示方針とは独立に働く。

### 0.2 pending 自己置換(ブラウザ所有権)

**解決した問題**: IP あたり同時 pending 3件の上限により、自分の投稿3件が未監査の間は
4件目の自己ベストが 429 で失われていた(当時の UI は 429 後に SUBMIT を隠していた)。

**仕組み**: クライアントは初回投稿時に `crypto.getRandomValues()` で 16 バイトを生成し、
32文字小文字 hex(`[0-9a-f]{32}`)として localStorage に保持して POST body の
`submitterToken` で送る(`src/ui/submitterToken.ts`)。サーバーはその **16 バイトに対する
鍵なし SHA-256** を `scores.submitter_hash` に保存する(`functions/_lib/ranking/submitterToken.ts`)。

- **鍵なしで足りる根拠**: トークンは 128bit の暗号学的乱数で候補空間が枚挙不能。
  低エントロピー入力である ip_hash が HMAC 鍵を要するのとは前提が違う。
- **未添付と不正形式は別扱い**: 未添付=旧クライアント/プライベートブラウズとして
  従来動作(置換なし・上限時 429)、添付だが形式不一致=**400**。
- **所有権の寿命は pending 期間だけ**: 監査の verified 化 UPDATE が
  `submitter_hash = NULL` に消す(永続的なブラウザ追跡 ID にしない)。
  **例外: 監査なしモード**では verified 行に `submitter_hash` を保存する(§7.4)。

**置換規則**: 通常の条件付き INSERT が `meta.changes=0`(上限到達)を返し、かつ
トークン添付がある場合のみ、**単一 `batch`(=単一トランザクション)** で
「自己 pending 1件の DELETE → 新規 INSERT」を再試行する。削除候補は
`status='pending'` かつ新鮮かつ `submitter_hash` 一致かつ **スコアが新申告を厳密に下回る**
行に限られ(同点は置換しない=先着優先)、`score ASC, rank_seq DESC LIMIT 1` で1件選ぶ。
新行は新規 `rank_seq` を得る(AUTOINCREMENT 不変規則は維持)。

**触ってはいけない設計上の核(変更時は必ず読むこと)**:

1. **DELETE の WHERE 句に上限の場合分けを埋め込む**。D1 の batch がロールバックするのは
   後続文が**エラー**のときだけで、`INSERT ... WHERE` が条件不成立で `changes=0` になるのは
   **成功扱い**。よって「DELETE 成功 → INSERT 0件 → 旧行だけ消える」は事後の `meta` 検査では
   防げない。場合分けは次の2つだけで、いずれも「DELETE がマッチした時点で同一トランザクション内の
   後続 INSERT の全上限条件の成立が保証される」形になっている:
   - 現 IP が上限ちょうど → **現 IP に属する**自己 pending のみ候補(別 IP の自己行を消しても
     現 IP 枠は空かない)
   - 現 IP に空きがあり全体が上限ちょうど → **任意の IP** の自己 pending が候補
   - どちらにも空きがある → 候補なし(batch 内の INSERT が普通に成立する)
2. **cutoff は batch 構築時に一度だけ評価し、batch 内の全文に同じ値をバインドする**。
   最初の INSERT 試行の値を使い回すことも、文ごとに再計算することも禁止。DELETE と INSERT が
   異なる 72時間境界で件数を数えると「DELETE=1 / INSERT=0」が復活する。SQLite の単一ライター性が
   保証するのは batch 内の非交錯だけで、最初の試行と batch の間の状態変化は防がない。

`replay_hash` UNIQUE 違反等の**エラー**時は batch 全体がロールバックされ旧行は失われない。
置換候補が無ければ従来どおり 429(UI は SUBMIT を残しリトライ可能にする)。
3層分離(事前ゲート・`displayEntries`・監査)には一切影響しない。

**監査なしモードの置換**: 上限付き INSERT と置換 DELETE に、監査なし用の固定 SQL が
それぞれ1本ある(実行時に断片を連結しない)。DELETE は、候補条件 `c.status = 'pending'` と
4つの COUNT の `status = 'pending' AND` の**6箇所をそろえて外した**だけで、他は同一
(cutoff を batch 内で共有する規則もそのまま)。場合分けの正しさは「削除候補が必ず両 COUNT の
数える集合に入っている」ことだけに依存し、述語を一様に外してもこれは保たれる。逆に、
DELETE と INSERT のモードがずれるとこの前提が崩れるため、モードは1リクエストにつき1回、
D1 操作の前に解決して batch の両文に同じ値を使う。監査なしでは自分の新鮮な verified 行
(監査ありの時期に残った pending 行も含む)が置換候補になる。

検証は `functions/_lib/ranking/pendingSelfReplace.test.ts`(実 D1。全ケースで
「消えた行があるなら必ず1行増えている」不変条件を機械的に検査。監査あり/なしの両モードで
同じケースを回す)、`functions/_lib/ranking/auditDisabledCaps.test.ts`(監査なしの上限境界・
置換の実 D1 検査)と `functions/_lib/ranking/scoresEndpoint.test.ts`(SQL 文字列と bind 値の
アサート。監査ありの SQL はモード導入前の文字列そのものに固定)。

## 1. ローカルでの手動実行手順

### 1.1 準備

```sh
# 1. マイグレーション適用(ローカル D1。0001 が未適用なら両方適用される)
npx wrangler d1 migrations apply qixxx-scores --local

# 2. ip_hash 鍵の用意(POST ハンドラ・監査コマンド両方が起動時に必須チェックする)
cp .dev.vars.example .dev.vars   # 値は開発用なら何でもよい(HMAC 鍵として不透明に扱われる)

# 3. ビルド + Pages Functions のローカルサーバー起動(バックグラウンド推奨)
npm run build
npx wrangler pages dev dist --port 8788 &
```

`wrangler pages dev` は `.dev.vars` を自動で読み込む(`RANKING_IP_HASH_KEY` が
`Using vars defined in .dev.vars` のログとともに Worker に渡る)。

### 1.1.1 ローカル D1 を扱う npm スクリプト

| コマンド | 内容 |
| --- | --- |
| `npm run ranking:local:show` | `scores` の全行をスコア順に表示 |
| `npm run ranking:local:clear-pending` | pending 行だけ削除(IP 別・全体の pending 上限を空ける) |
| `npm run ranking:local:reset` | 全行削除(verified 含む。ランキングをまっさらに) |
| `npm run ranking:local:audit` | 監査を1回実行(`.dev.vars` の鍵を読んで §1.3 と同じことをする。正当な pending は verified 化、偽スコアは削除) |

いずれも `wrangler pages dev` を起動したまま実行してよい(同じローカル D1 を参照する)。

### 1.2 投稿(pending 保存)

```sh
curl -X POST http://localhost:8788/api/scores \
  -H "Origin: http://localhost:8788" -H "Content-Type: application/json" \
  -H "CF-Connecting-IP: 203.0.113.1" \
  -d '{"seed":4242,"rleBase64":"<base64>","score":1234,"stage":2,"name":"TESTER","rulesetVersion":1,"replayFormatVersion":1}'
```

応答: `{"accepted":true,"id":"...","status":"pending","message":"...", "score":1234,"stage":2,"durationTicks":<サーバー導出値>}`

`rleBase64` は実際のゲームプレイでなくても(RLE として復号さえできれば)受理される
— POST は `verifyReplay()` を一切呼ばないため。`GET /api/ranking` の `displayEntries`
(verified と新鮮な pending を統合した表示用の順位表)に `status:"pending"` の行として
反映されることを確認する。投稿可否判定に使う `entries`(verified の確定 TOP10)は
このとき一切変化しない。

### 1.3 監査実行

```sh
RANKING_IP_HASH_KEY=$(grep RANKING_IP_HASH_KEY .dev.vars | cut -d= -f2) \
  npx vite-node scripts/audit/cli.ts
```

`.dev.vars` は Node プロセス(`vite-node`)には自動で読み込まれない
(`wrangler pages dev` 固有の機構)ため、上記のように環境変数として渡す必要がある。

出力例:

```
[audit] rate-limit housekeeping deleted=0
[audit] {"type":"lock-acquired","runStartedAt":1787156043}
[audit] {"type":"expired-pending-deleted","count":0}
[audit] {"type":"chunk-fetched","count":1}
[audit] {"type":"entry-verified","id":"..."}
[audit] {"type":"top10-cleanup","deletedCount":0}
[audit] {"type":"lock-released","released":true}
[audit] done. runStartedAt(D1 unixepoch)=... processed=1 verified=1 ... leaseLostMidRun=false lockReleased=true
```

最終行が `done.` ではなく `INCOMPLETE (lease lost mid-run ...)` になり、
終了コードが 1 になる場合(`leaseLostMidRun=true` または `lockReleased=false`)は、
実行の途中でリース(`audit_lock`)を失っており、**残りの pending 行や TOP10 整理を
意図的に中断している**。リース10分 > 最大実行時間5分の設計上
本来起きないはずの状態なので、起きたら実行時間・D1 の応答遅延を確認すること。
未処理分は次回実行が引き継ぐため、DB 自体は壊れていない
(中断後の書き込みはフェンシングで一切適用されない)。

確定した行は `GET /api/ranking` の `entries`(確定 TOP10)に現れ、`displayEntries`
では同じ順位のまま `status` が `"pending"` から `"verified"` に変わる(順位は動かず、
UI 上の見た目も変わらない — §0.1.1)。`GET /api/ranking/:id/replay` は pending の
間も 200 で見られる(応答に `status:"pending"` が含まれるが、ビューアは描画に使わない)。404 になるのは「行が無い/監査で削除済み」か「pending かつ期限切れ
(`created_at <= now-72h`)」の場合のみ。

### 1.4 偽スコアの削除を確認する

`score` に実際のシミュレーション結果と異なる値を入れて POST すると、
`accepted:true` で一旦 pending になり、`GET /api/ranking` の `displayEntries` に
`status:"pending"` の行として(スコア順の本来の位置に)表示される。監査を実行すると `verifyPendingEntry()` が `declared-score-mismatch`
と判定して即削除される(`entry-deleted-confirmed-invalid` イベント、
`reason:"declared-score-mismatch"`)。

上記 1.2〜1.4 は実機(`wrangler pages dev` + 実 D1 + `scripts/audit/cli.ts`)で
通しで動作することを確認している。

---

## 2. D1 スキーマ(非同期監査のために追加した列)

スキーマ全体の定義・インデックス・クエリとの対応は [`docs/ranking-schema.md`](./ranking-schema.md) を参照。

`migrations/0002_ranking_free_async.sql` が `scores` テーブルに追加する列:

| 列 | 型 | 意味 |
| --- | --- | --- |
| `status` | `TEXT NOT NULL DEFAULT 'verified'` | `'pending'` / `'verified'`。既存行は `'verified'` にバックフィル(再監査対象にしない) |
| `ip_hash` | `TEXT`(nullable) | `HMAC-SHA-256(CF-Connecting-IP)`(IPv6 は /64 に丸めてから)。既存行は `NULL`(生成当時この列がなかったため) |
| `audit_attempts` | `INTEGER NOT NULL DEFAULT 0` | 予期しない例外によるリトライ回数 |
| `next_attempt_at` | `INTEGER`(nullable) | unixepoch() 秒。リトライ対象行の次回取得可能時刻 |

`migrations/0003_submitter_hash.sql` が追加する列(§0.2):

| 列 | 型 | 意味 |
| --- | --- | --- |
| `submitter_hash` | `TEXT`(nullable) | 投稿者トークン16バイトの**鍵なし SHA-256**。`NULL` は「所有者なし=誰にも置換されない」で、(1) この列より前の行、(2) トークン未添付の投稿、(3) 監査が verified 化した行(UPDATE で NULL に戻す)の3通り |

インデックス `idx_scores_pending_submitter(status, submitter_hash, score)` が
置換候補の探索(`status='pending' AND submitter_hash=? AND score<? ORDER BY score ASC`)を支える。

新設テーブル `audit_lock(id, owner_token, locked_until)`: 監査ジョブの多重起動防止用ロック。
`id=1` の1行のみ、初期行はマイグレーション自体が投入する(`owner_token=''`, `locked_until=0`)。

`migrations/0004_ranking_rate_limits.sql` は次のテーブルを追加する。

| 列 | 型 | 意味 |
| --- | --- | --- |
| `ip_hash` | `TEXT PRIMARY KEY` | `RANKING_IP_HASH_KEY` による HMAC-SHA-256。生 IP は保存しない |
| `window_index` | `INTEGER` | `floor(now_ms / 3,600,000)` の固定窓 |
| `request_count` | `INTEGER` | 現在窓の消費数。1以上 |
| `updated_at` | `INTEGER` | サーバー時刻の Unix epoch 秒 |

1 IP ハッシュ1行で、次窓の最初の UPSERT が同じ行を `request_count=1` に戻す。
監査コマンドはスコア監査の前に `updated_at` が24時間より古い行を自動削除し、
公開ログへ削除件数だけを出す。24時間ちょうどの行と現行窓は削除しない。
housekeeping が失敗してもスコア監査は続行するが、固定された失敗表示を出して
コマンドの終了コードを非0にする。成否と件数は `RunAuditResult` に混ぜない。

状態確認と手動 cleanup:

```sh
# local
npx wrangler d1 execute qixxx-scores --local --command \
  "SELECT COUNT(*) AS rows, MIN(updated_at) AS oldest_updated_at FROM ranking_rate_limits"
npx wrangler d1 execute qixxx-scores --local --command \
  "DELETE FROM ranking_rate_limits WHERE updated_at < unixepoch() - 86400"

# remote（対象アカウント・DB を確認してから実行）
npx wrangler d1 execute qixxx-scores --remote --command \
  "SELECT COUNT(*) AS rows, MIN(updated_at) AS oldest_updated_at FROM ranking_rate_limits"
npx wrangler d1 execute qixxx-scores --remote --command \
  "DELETE FROM ranking_rate_limits WHERE updated_at < unixepoch() - 86400"
```

## 2.1 migration 0004 のデプロイとロールバック

デプロイ順は固定する。

1. 対象 D1 に migration 0004 を適用する。
2. `ranking_rate_limits`、`idx_ranking_rate_limits_window`、`idx_ranking_rate_limits_updated_at` の存在を確認する。
3. 新しい Pages Functions をデプロイする。
4. 正常投稿、同一 IP ハッシュの30/31回境界、`Retry-After`、ランキング投稿由来の KV write が増えないことを確認する。

テーブルより先にコードを出すと全投稿が fail-closed の500になる。ロールバック時は旧コードへ戻し、
追加テーブルは即時 DROP しない。旧コードの動作確認後、不要と確定した場合のみ別作業で削除する。
旧コードへ戻る間、ランキング投稿の制限も KV の1時間10回へ戻ることを運用者へ明示する。

## 2.2 migration 0005(rng_key UNIQUE)のデプロイ

0005 は `scores.rng_key`(実効 seed = `deriveStageSeed(seed, 1)`)を追加し、既存行を
SQL 内の FNV-1a でバックフィルしてから UNIQUE インデックスを張る。3 文が 1 バッチなので、
既存行に同じ `rng_key` の組(同じ seed の重複、または同じ乱数系列になる別 seed)があると
インデックス作成で失敗し、**列追加も含めて全体がロールバック**される(D1 は何も変わらない)。
適用前に対象 D1 で衝突を確認し、あれば手動で整理する(テスト投稿の残骸が典型。どちらを残すかは
運用者判断、通常は `rank_seq` の小さい方)。

```bash
wrangler d1 execute qixxx-scores --remote --command "
WITH RECURSIVE fnv(rank_seq, s, i, h) AS (
  SELECT rank_seq, CAST(seed AS TEXT) || ':1', 1, 2166136261 FROM scores
  UNION ALL
  SELECT rank_seq, s, i + 1,
         (((h | unicode(substr(s, i, 1))) - (h & unicode(substr(s, i, 1)))) * 16777619) & 4294967295
  FROM fnv WHERE i <= length(s)
)
SELECT fnv.h AS rng_key, COUNT(*) AS n, GROUP_CONCAT(scores.id) AS ids, GROUP_CONCAT(scores.seed) AS seeds
FROM scores JOIN fnv ON fnv.rank_seq = scores.rank_seq AND fnv.i = length(fnv.s) + 1
GROUP BY fnv.h HAVING n > 1"
```

0 行なら適用できる。

**コードは 0005 に依存する**: 投稿 API の INSERT は `rng_key` 列を名指しするので、列がないと
全投稿が 500 になる。順序は必ず migration → `idx_scores_rng_key` の存在確認 → Pages Functions
デプロイ。ロールバックで旧コードへ戻しても列・インデックスは残してよい(旧コードは列を無視し、
新規行の `rng_key` は `NULL` になる。UNIQUE は `NULL` を区別しないので旧コードの動作を妨げないが、
その間に入った行はあとで 0005 のバックフィル文を手で流して埋める)。

Paid 同期検証へ切り替える際の必須チェック:

1. `verifyReplay()` を投稿内で同期実行する。
2. 新規行を最初から `verified` で保存する。
3. 切替前に既存 pending を監査して空にする。
4. pending の72時間期限、IP 3件、全体200件、自己置換を停止する。
5. 非同期スコア監査を停止する。
6. D1 レート制限を同期検証より前に残し、30回/時の変更は本番メトリクスに基づく別判断にする。
7. 非同期監査停止後も housekeeping だけを残すか、Cloudflare 側レート制限への移行を完了してから D1 housekeeping を止める。

---

## 3. 本番 D1 接続と定期実行

本番監査は Cloudflare D1 HTTP REST API の query endpoint を使う。
`npm run ranking:remote:audit` だけが remote adapter を選び、SQL と bind 値は
`sql` / `params` に分離して送る。HTTP 失敗や応答形式不正を自動リトライしない。
書き込み適用後に応答だけ失われた場合をクライアントから安全に判別できないため、
失敗した run は非0で終え、D1 ロックの失効後に次の定期起動へ委ねる。

必須設定は次のとおり。空値を含む不足は DB/fetch より前に
`RemoteD1ConfigurationError` で終了する。

| 環境変数 | launchd |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | Keychain |
| `CLOUDFLARE_ACCOUNT_ID` | plist |
| `CLOUDFLARE_D1_DATABASE_ID` | plist |
| `RANKING_IP_HASH_KEY` | Keychain |

`CLOUDFLARE_D1_DATABASE_ID` は `wrangler.toml` の `database_id` と一致させる。
API token は対象 account の D1 Write/Edit のみに絞る。これより広い Workers、Pages、
Account Settings、Zone 権限を要求される場合は launchd を有効にせず、権限と接続先を確認する。

launchd は毎時 2, 7, 12, …, 57 分の5分間隔で監査を実行する
(`scripts/audit/launchd/com.qixxx.ranking-audit.plist.example` の
`StartCalendarInterval`)。手動実行(`npm run ranking:remote:audit`)と
launchd の定期実行が重なっても、D1 の10分 lease、heartbeat、fenced write が
排他を担うため安全(`audit_lock` の詳細は §0 参照)。300秒の retry delay は
最小の通常起動間隔以下という目安で、正確な起動時刻を保証しない。

remote の固定エラーは次の4種類で、response body、Cloudflare の error message、URL、
account/database ID、token、Authorization、SQL、params を保持・出力しない。

- `RemoteD1ConfigurationError`: 必須設定の不足または空値
- `RemoteD1RequestError`: fetch 例外または HTTP 非2xx
- `RemoteD1ResponseError`: JSON または応答 envelope の形式不正
- `RemoteD1QueryError`: top-level または個別 query の失敗

設定済み環境での手動疎通は、対象 DB と commit を確認してから次で1回だけ行う。

```sh
npm run ranking:remote:audit
```

### 3.1 有効化順序

順序を入れ替えない。

1. 実装とは別の運用作業で `wrangler d1 migrations apply qixxx-scores --remote` を実行する。
   本番 migration は監査有効化前の必須依存であり、この実装の検証には含めない。
2. reviewed commit の checkout から `npm run ranking:remote:audit` を1回実行し、
   `done.`、`lockReleased=true`、既知 pending の確定または削除、ログの秘匿を確認する。
3. reviewed commit を main へマージする。
4. §3.3 の launchd を導入し、通常周期とスリープ復帰を確認する。

**監査なしモード(§7)で運用していた D1 に監査を導入するときは、この順序ではなく
§7.8 に従う。** 特に手順 2 の「手動で1回実行」を差し戻し SQL より前に行わないこと
(未監査の verified 行の11位以下が削除され、取り消せない。§7.6)。

### 3.3 launchd の導入

1. 自動更新を行わない専用の main checkout を用意する。運用者が reviewed commit を
   確認して明示的に更新する場所とし、ラッパーから `git pull`、install、checkout 更新を行わない。
2. 専用 checkout で `npm ci` を実行する。
3. Keychain service `qixxx-ranking-audit` に2 secret を対話入力する。値をコマンドラインに書かず、`-A` を使わない。

   ```sh
   security add-generic-password -U -s qixxx-ranking-audit -a CLOUDFLARE_API_TOKEN -w
   security add-generic-password -U -s qixxx-ranking-audit -a RANKING_IP_HASH_KEY -w
   ```

4. `scripts/audit/launchd/com.qixxx.ranking-audit.plist.example` を
   `$HOME/Library/LaunchAgents/com.qixxx.ranking-audit.plist` へコピーし、5種類の
   placeholder を置換する。repo path は専用 checkout、node bin dir は `node` と
   `npm` が存在するディレクトリ、log dir は専用ディレクトリ、account/database ID は
   確認済み値とする。`rg '__[A-Z0-9_]+__' <plist>` が0件になることを確認する。
5. log dir を700にし、stdout/stderr ファイルを事前作成して600にする。

   ```sh
   mkdir -p <log-dir>
   chmod 700 <log-dir>
   touch <log-dir>/ranking-audit.stdout.log <log-dir>/ranking-audit.stderr.log
   chmod 600 <log-dir>/ranking-audit.stdout.log <log-dir>/ranking-audit.stderr.log
   ```

6. `plutil -lint <plist>` を実行する。追加検査には公開版
   [launchd-plist-generator](https://launchd-plist-generator.orukubami.sh) と
   GitHub リポジトリ `shimabox/launchd-plist-generator` を使う。リポジトリを clone し、
   展開済み plist に対して strict check を行う。

   ```sh
   git clone https://github.com/shimabox/launchd-plist-generator.git <launchd-plist-generator-dir>
   cd <launchd-plist-generator-dir>
   node bin/launchd-plist check <plist> --strict
   ```

7. 登録して即時起動する。

   ```sh
   launchctl bootstrap gui/$(id -u) <plist>
   launchctl kickstart -k gui/$(id -u)/com.qixxx.ranking-audit
   ```

8. 登録後に検査とログ確認を行う。

   ```sh
   node bin/launchd-plist doctor <plist>
   launchctl print gui/$(id -u)/com.qixxx.ranking-audit
   ```

   stdout/stderr と `done.` / `lockReleased=true` を確認する。
9. 2つ以上の予定時刻をまたいで Mac をスリープさせ、復帰時に missed run が1回だけ
   補完され、その後は次の5分 slot で通常実行されることを確認する。

### 3.4 専用 checkout の更新とログローテーション

更新時は `launchctl bootout gui/$(id -u)/com.qixxx.ranking-audit` で停止し、運用者が
reviewed commit を確認して main を fast-forward 更新する。`npm ci`、commit SHA、
typecheck・lint・test・build の gate を確認し、必要なら plist を再検査してから
`bootstrap` する。ラッパー自身は checkout 更新や install を行わない。

ログローテーションは `bootout` → timestamp 付きファイルへ rename → 空ファイルを再作成
→ `chmod 600` → 必要なら旧ログを圧縮または期限削除 → `bootstrap` の順に行う。
launchd の開いた file descriptor を残さず、secret が含まれないことを確認してから保管する。

### 3.5 停止、ロールバック、障害対応

無効化・ロールバックでは launchd の `bootout` を行う。
`audit_lock` の解放または10分失効を確認する。remote adapter を revert しても
schema は DROP せず、verified 化や削除を自動で戻さない。

- Keychain failure: account/service 名、login Keychain の unlock/ACL、ラッパーの stderr を確認する。secret を plist やファイルへ退避しない。
- 401/403: token の対象 account と D1 Write/Edit 権限、account/database ID を確認する。権限を広げない。
- 429: launchd を止め、Cloudflare API の rate limit を確認する。自動 retry を追加しない。
- response error: launchd を止め、API 応答仕様と fixture の差を確認する。想定外 BLOB を成功扱いしない。
- lease loss: `leaseLostMidRun` / `lockReleased` と D1 遅延を確認する。10分 lease や5分 runtime を独断で変更しない。
- Mac 停止: バックストップは存在しない。pending は Mac が復帰して次の launchd 実行が
  走るまで待つか、それより先に(§0 の)期限で削除される。復旧後は通常周期での
  launchd 実行を確認する。
- token 漏洩疑い: Cloudflare token を失効・再発行し、Keychain を更新する。

本番 migration 未適用、Pages/Keychain の鍵一致を値の出力なしに確認できない、
数値 bind や BLOB が想定と異なる場合は launchd を有効にせず運用者確認で停止する。

## 4. ip_hash 鍵の管理

- アルゴリズム: HMAC-SHA-256(固定)。生 IP は保存しない。固定ソルト付き SHA-256 は不可
  (IP は低エントロピーで公開ソルトでは総当たり可能なため)。
- ローカル: `.dev.vars`(gitignore 済み。`.dev.vars.example` を雛形として使う)。
- 本番: Cloudflare Pages の secret(`wrangler pages secret put RANKING_IP_HASH_KEY`)。
- 定期監査: Keychain service `qixxx-ranking-audit`。Pages と同じ値を登録するが、値をログへ出して比較しない。
- 鍵が未設定の場合、POST ハンドラ・監査コマンドの両方が **DB 操作前に** 検出して
  fail-closed する(`functions/_lib/ranking/ipHash.ts`)。生 IP へのフォールバックはしない。

## 5. ログ方針(共有前提)

**launchd のログは `$HOME` 配下のローカルファイルだが、デバッグのために共有され得る。**
監査ジョブが出力するものは「運用者だけが見るコンソール」ではなく
**共有され得る成果物** として扱い、公開ログと同じルールを適用する。
対象は `scripts/audit/cli.ts` の標準出力/標準エラー、`runAudit()` が emit する
`AuditEvent` 全種(cli がそのまま JSON で印字する)、および launchd の
stdout/stderr ログファイル(§3.3)の内容。

### 5.1 出してよいもの / いけないもの

| 分類 | 例 | 可否 | 理由 |
| --- | --- | --- | --- |
| 集計値 | 件数(`count` / `deletedCount` / `attempts`)、`reachedTimeLimit`、処理時間 | **可** | 個人と結びつかない |
| イベント種別 | `entry-verified` / `top10-cleanup` / `lease-lost-*` 等 | **可** | 挙動の説明のみ |
| 公開 API で既に見える値 | 行の `id`(共有 ID)、確定スコア、`runStartedAt` | **可** | `GET /api/ranking` で誰でも取得できる |
| 却下理由の**種別** | `reason:"declared-score-mismatch"` / `"season-mismatch"` | **可** | 種別止まり。**申告値と実測値の対比は出さない**(entry id まで) |
| `ip_hash` | `ip_hash` 列の値、その一部 | **不可** | ハッシュでも同一人物の投稿を横断突合でき、既知 IP との照合も可能 |
| `submitter_hash` | `submitter_hash` 列の値、その一部 | **不可** | `ip_hash` と同格。ハッシュでも同一ブラウザの投稿を横断突合できる |
| 投稿者トークン | クライアントが送る**生の** `submitterToken` | **不可** | 生値を知られると、その pending 行を他人が置換できる(所有権そのもの)。サーバーは保存もログもしない |
| `owner_token` | `audit_lock.owner_token` | **不可** | 他プロセスがフェンスを詐称できる |
| 鍵に類する値 | `RANKING_IP_HASH_KEY`、接続文字列、認証情報 | **不可** | 言うまでもなく |
| 生のエラーオブジェクト | `console.error('...', err)`、`String(err)`、スタック | **不可** | メッセージ/スタックに絶対パス・接続先・SQL 断片が混ざり得る |

エラーは `scripts/audit/logSafety.ts` で **クラス名だけに丸めて** 出す
(`errorName:"TypeError"`)。`TypeError` と D1 障害を区別してリトライ判断するには
これで十分。メッセージ本文の**先頭1行のみ**(スタックなし・200字で打ち切り)は
ローカル実行時に環境変数 `AUDIT_LOG_ERROR_DETAIL=1` を付けたときだけ出る
— **launchd の定期実行では絶対に設定しない**。

クラス名は**固定の許可リスト**(`ALLOWED_ERROR_NAMES`)と照合し、載っていない名前は
すべて `UnknownError` にする。`Error#name` は書き換え可能なただのプロパティなので、
「識別子の形をしている」ことは本物のクラス名である証拠にならない
(`{name:"Secret_supersecret"}` がそのまま共有ログに出てしまう)。
許可リストに足すのは **どこで throw されるかを確認したクラスだけ**。
未収載のクラスは `UnknownError` になるが、それはローカル再実行1回で特定できる
コストであり、素性不明の文字列を共有してしまう損失とは釣り合わない。

### 5.2 エントリポイントの構造(初期化例外の取りこぼし防止)

`scripts/audit/cli.ts` は **最小の bootstrap** であり、コマンド本体は
`./auditCommand` を **動的 import** して読み込む。静的 import にすると
**モジュール初期化中の throw** が bootstrap の catch より前に発生し、
vite-node が生スタック(絶対パス込み)を共有ログに出してしまうため
(`scripts/audit/constants.ts` はトップレベル `throw` で不変条件を検査しており、
この経路は実在する)。

- `cli.ts` の静的 import は **`./logSafety` の1つだけ**に保つこと。
  logSafety.ts は依存ゼロ・副作用なし(定数と正規表現と Set のみ)で、
  それ自身が初期化時に throw しないことが構造的に保証されている。
- **サニタイズ関数自身が throw してはならない。** `safeErrorName()` /
  `safeErrorDetail()` の引数は「誰かが throw した `unknown`」であり、
  `err.name` の**プロパティ参照そのもの**が例外になり得る
  (throwing getter、`get` トラップが throw する Proxy)。
  これらの関数の呼び出し元は catch ハンドラだけなので、ここで throw すると
  **サニタイズしようとしていた catch を突き抜けて**生スタックが出る。
  プロパティ取得はすべて try/catch で包み、失敗時は `UnknownError` /
  詳細なしにフォールバックすること。
- この3点は `scripts/audit/cli.test.ts` が静的検査 + 実サブプロセス起動で担保する
  (throwing getter を持つ値を初期化時に throw するケースを含む)。

```sh
# ローカルで詳細を見たいときだけ
AUDIT_LOG_ERROR_DETAIL=1 RANKING_IP_HASH_KEY=... npx vite-node scripts/audit/cli.ts
```

### 5.3 イベントを追加するときのチェック項目

`AuditEvent` に種別やフィールドを足すときは、以下を**すべて**確認する。

- [ ] 追加フィールドは 5.1 の「可」に該当するか(集計値・種別・公開済みの値のいずれか)。
- [ ] 行の内容をそのまま載せていないか(`ip_hash` / `submitter_hash` はもちろん、
      `name` / `x_handle` / `seed` / `inputs` も監査ログには不要 — 必要なのは `id` だけ)。
- [ ] 例外を扱うイベントなら、`safeErrorName()` / `safeErrorDetail()` を通しているか
      (`err` をそのまま埋め込んでいないか)。
- [ ] `scripts/audit/runAudit.test.ts` の `ALLOWED_EVENT_FIELDS` と `EVENT_FIXTURES`
      の**両方**に追加したか。どちらも `AuditEvent['type']` のマップ型なので、
      種別を足すと **`npm run typecheck` がコンパイルエラーで落ちる**
      (意図的なゲート。上のチェックを通してから追加する)。
- [ ] fixture は**その種別が持ちうる全フィールド**(任意フィールド含む)を
      埋めたか。fixture の型は `Required<Extract<AuditEvent, {type:K}>>` なので、
      `foo?: string` のような**任意フィールドを追加しただけでもコンパイルが落ちる**
      (任意のままだと「実際には出力されるのに fixture も許可表も未更新で型検査を
      通る」抜け道になるため)。実際に発生させるのが難しい種別(`lease-lost-*` 等)も
      fixture 経由で必ず衛生チェックを通る。

## 6. 既知の残余リスク

- D1 REST API の BLOB 表現は、migration 後の初回手動疎通で確認する。
- launchd と Keychain はログイン状態、Keychain lock、ACL の影響を受ける。
- Free 10ms CPU 適合の最終確定(実測 `cpuTime`)は未了 — デプロイ後の
  Cloudflare preview 環境での実測に委ねる。
- 監査までの偽スコア表示窓(通常運用で launchd の5分間隔+実行時間、リトライ対象は最大3周期まで。
  Mac のスリープ・電源断で launchd 実行自体が遅延・欠落し得るため、いずれも保証値ではなく目安)
  は非同期監査方式の本質的なトレードオフであり、実装で解消できるものではない
  (同期検証を行う Paid 版にはこの窓がない)。pending は `displayEntries` に
  統合表示されるため、この窓の間、偽スコアは表示上の実際の順位を
  一時的に占有し得る(占有は最大3行。投稿の受理可否は `entries` 基準の事前ゲートのみに
  依存するため、正当な投稿が妨害されることはない)。
- **監査なしモード(§7)の間は、上の保護がどれも働かない。** 監査なしの間はクライアント
  申告のスコアを信じる。偽スコアを送れる。偽 10 件で投稿が締め出される(偽スコアの
  verified 行が10位閾値になり、それを超えない正規の投稿は事前ゲートで保存されない)。
  リプレイがスコアと一致する保証がない。表示 pending 上限3件という偽スコア対策も、
  全行が verified なので効かない。不正が問題になったら §7.8 で監査ありへ切り替える。

---

## 7. 監査なしモード(`RANKING_AUDIT_MODE`)

全体像とリスクは §0.0 を参照。この節は設定・確認・日常運用・切替の手順をまとめる。
SQL の `<CURRENT_SEASON_ID>` / `<RULESET_VERSION>` / `<REPLAY_FORMAT_VERSION>` は、
[`docs/ranking-runbook.md`](./ranking-runbook.md) §2 手順0 と同じく毎回ソースを見て
置き換える(`REPLAY_FORMAT_VERSION` も `src/config.ts`)。この節の SQL は
`scripts/audit/auditModeInteraction.test.ts` が実 D1 で検証しており、同テストは
この文書に同じ文字列が載っていることも検査する(SQL を変えるときは両方を直す)。
コマンドは本番向けに `--remote` 付きで書いてある(`docs/ranking-runbook.md` 冒頭の警告を参照)。

### 7.1 環境変数

| 項目 | 内容 |
| --- | --- |
| 名前 | `RANKING_AUDIT_MODE` |
| 値 | `disabled` = 監査なし、`enabled` = 監査あり |
| 解釈 | `trim()` と小文字化のあと `disabled` に一致したときだけ監査なし。**未設定・空・未知の値はすべて監査あり**。未知の値では、値そのものを含まない警告を `console.warn` に出す |
| 既定値 | 監査あり(未設定と同じ) |
| 置き場 | Cloudflare Pages の **Production 環境**の変数。`npx wrangler pages secret put RANKING_AUDIT_MODE`(`RANKING_IP_HASH_KEY` と同じ経路。プロンプトに値を入力する)か、Pages ダッシュボードの Settings → Variables and Secrets(Production)。secret でも平文の変数でもよいが、このリポジトリは `wrangler.toml` を Pages の設定の正本にしているため、ダッシュボードで平文の変数を編集できない場合がある。その場合は secret として設定する |
| ローカル | `.dev.vars`(`.dev.vars.example` を参照) |
| 反映 | Pages の変数の変更は**新しいデプロイから**反映される。変更後に、同じコミットを再デプロイする(ダッシュボードの最新 Production デプロイで Retry deployment 等)。**コード変更は不要** |

**`wrangler.toml` の `[vars]` には置かない。** 置くと切替のたびに main へのコミット
(=本番デプロイ)が必要になり、コード変更なしに切り替えるという目的に反する。

既定を監査ありにしているのは、設定漏れや打ち間違いの被害を小さくするため(未検証スコアは
pending のまま残り、72時間以内なら後から監査できる。逆の既定だと、未検証スコアが黙って
確定順位になり、事前ゲートの閾値まで動かす)。代償として、**監査なしで公開するときは
`disabled` の明示設定が必須**で、忘れると投稿は誰も監査しない pending になり、表示は
最大3件、72時間で表示から消える。§7.3 の確認を公開チェックに入れる。

### 7.2 production と preview は同じ D1 を使う

`wrangler.toml` の D1 バインディングは `DB` の1つだけで、production と preview の
デプロイが同じ D1(`qixxx-scores`)に書き込む。**preview 環境に `RANKING_AUDIT_MODE` を
設定しなければ、preview からの投稿は監査ありで(pending として)保存される。** 共有 D1 に
未監査の verified 行を書かないよう、preview には設定しないこと。監査なし運用中に preview から
入った pending 行は誰も監査しないので、72時間後に表示から消え、§7.5 の掃除 SQL で削除される。

### 7.3 公開チェックと現在のモードの確認

secret として設定した値は読み戻せない。現在のモードは、**最新行の `status` を D1 で見て**
確認する。切替後と公開直後は、実際に1件投稿してから次を実行する。

```sh
npx wrangler d1 execute qixxx-scores --remote --command \
  "SELECT id, status, datetime(created_at/1000,'unixepoch') AS created FROM scores ORDER BY rank_seq DESC LIMIT 1"
```

監査なしのつもりで `pending` なら設定が効いていない(Production 環境に設定したか、
変更後に再デプロイしたかを確認する)。POST 応答の `status` も同じ値を返す
(`verified` なら UI は「SUBMITTED.」と表示する)。

### 7.4 `'verified'` の意味と `submitter_hash`

- 監査なしモードの間に入った行は、**未監査のまま `verified`** になる。`'verified'` は
  「監査済み」ではなく「ランキング対象」を意味する。どの行が監査済みかを示す列や記録はない。
- 監査なしでは、自己置換(§0.2)を有効にするために **`submitter_hash` を verified 行に
  保存する**。「verified 化で `NULL` に消す」という監査ありの不変条件からの逸脱である
  (ブラウザ間の突合に使える値なので、ログに出さない方針は §5 のとおり変わらない)。
  消すときは次の SQL を流す。消した行は以後だれにも置換されないので、その IP からの
  4件目は、72時間の窓が空くまで 429 になり得る。

```sql
UPDATE scores SET submitter_hash = NULL
WHERE status = 'verified' AND submitter_hash IS NOT NULL;
```

### 7.5 監査なしで止まるものと、手での運用

監査なし・launchd 未導入(想定運用)では、監査コマンドが担っていた次の3つが止まる。

| 止まるもの | 影響 | 手での運用 |
| --- | --- | --- |
| 期限切れ pending の掃除 | 切替前・preview から入った pending 行が残り続ける(表示・リプレイには出ない) | 下の掃除 SQL を定期的に流す |
| TOP10 整理 | `scores` に11位以下の verified 行も残り続ける(上限は72時間あたり最大200行の追加) | 容量確認 SQL で見て、必要なら手動トリム SQL |
| `ranking_rate_limits` の housekeeping | IP ハッシュ1つにつき1行が増え続ける | §2 の手動 cleanup SQL(`DELETE FROM ranking_rate_limits WHERE updated_at < unixepoch() - 86400`)を定期的に流す |

期限切れ pending の掃除(監査冒頭の削除と同じ境界 `created_at <= now - 72h`):

```sql
DELETE FROM scores
WHERE status = 'pending' AND created_at <= (unixepoch() - 259200) * 1000;
```

容量確認(状態別の行数・入力列の合計バイト数・最古の行)。DB 全体のサイズは
`npx wrangler d1 info qixxx-scores` で見られる(Free は1DBあたり500MB)。

```sh
npx wrangler d1 execute qixxx-scores --remote --command \
  "SELECT status, COUNT(*) AS rows, SUM(length(inputs)) AS input_bytes, datetime(MIN(created_at)/1000,'unixepoch') AS oldest FROM scores GROUP BY status"
```

手動トリム(現行シーズン・ルールセットの verified を上位 `<KEEP_ROWS>` 件だけ残す。
`10` にすると監査の TOP10 整理と同じ)。**トリムすると繰り上げ候補が消える**:
上位の偽スコアを後で消しても、トリム済みの正規行は戻らない。余裕を持たせた件数
(例: `100`)で残すことを勧める。削除は取り消せないので、先に容量確認と
`docs/ranking-runbook.md` §2 手順1の SELECT で対象を確かめる。

```sql
DELETE FROM scores
WHERE status = 'verified'
  AND season_id = <CURRENT_SEASON_ID>
  AND ruleset_version = <RULESET_VERSION>
  AND rank_seq NOT IN (
    SELECT rank_seq FROM scores
    WHERE status = 'verified'
      AND season_id = <CURRENT_SEASON_ID>
      AND ruleset_version = <RULESET_VERSION>
    ORDER BY score DESC, rank_seq ASC
    LIMIT <KEEP_ROWS>
  );
```

上限付き INSERT の COUNT は監査なしでは `status` で絞らないため、`status` 先頭の
複合インデックスで範囲検索できず、`idx_scores_pending_created` /
`idx_scores_pending_ip_created` の全体を走査する(どちらも `inputs` を含まない
カバリングインデックスなので BLOB は読まない)。自己置換の候補探索は、上限到達かつ
トークン付きの投稿のときだけ `scores` を走査する。行数が増えて重くなったら手動トリムで減らす
(インデックス追加は migration が必要なので別作業)。

### 7.6 監査なし中に監査が誤って動いた場合

監査は Mac 側で動き、Pages の変数を読めないので、モードを見て止まる仕組みはない。
監査なし中に `npm run ranking:remote:audit` や launchd が動くと次のようになる
(`scripts/audit/auditModeInteraction.test.ts` で挙動を固定している)。

- pending が無いので、検証は0件(housekeeping は動くが無害)。
- **TOP10 整理が、現行シーズン・ルールセットの verified 11位以下を削除する。** 未監査の行で、
  **取り消せない**。上位に偽スコアがいた場合、それを消したあとに繰り上がるはずの正規行が
  失われる。

監査準備(トークン設定)の前なら `RemoteD1ConfigurationError` で止まるので起きにくい。
危ないのは監査ありへの切替の途中で、§7.8 の順序を守る。

### 7.7 監査あり → 監査なしへの切替

順序は次のとおりで、**入れ替えない**。

1. 監査を手動で1回実行して pending を減らす(`npm run ranking:remote:audit`)。
2. launchd を `bootout` して監査を止める(`launchctl bootout gui/$(id -u)/com.qixxx.ranking-audit`)。
3. Production 環境に `RANKING_AUDIT_MODE=disabled` を設定し、同じコミットを再デプロイする(§7.1)。
   デプロイ完了後に1件投稿し、§7.3 の SQL で新規行が `verified` で入ることを確認する。
4. 残った pending 行を、監査なしモードと同じ扱いとして verified に変える(下の SQL)。
5. 以後、監査は実行しない。

順序の理由: pending を0にして監査を止めても、再デプロイが完了するまでは POST が pending を
保存し、それらは未監査のまま72時間で表示・リプレイから消える(手順4がそれを拾う)。また、
再デプロイ後に監査を走らせると、未監査の verified 行の11位以下が削除される(§7.6)。

手順4の SQL。`submitter_hash` は監査なしモードと同じく保持する(SET しない)。旧シーズン・
旧ルールセット・旧フォーマットの pending 行は対象外で、72時間後に §7.5 の掃除 SQL で消える。

```sql
UPDATE scores
SET status = 'verified', audit_attempts = 0, next_attempt_at = NULL
WHERE status = 'pending'
  AND season_id = <CURRENT_SEASON_ID>
  AND ruleset_version = <RULESET_VERSION>
  AND replay_format_version = <REPLAY_FORMAT_VERSION>;
```

切替直後は、直近72時間の**監査済み** verified 行も上限(全体200・IP あたり3)の件数に入る。
件数が上限を超えている IP は、自己置換の場合分けが「ちょうど上限」のときしか候補を
出さないので 429 になる(行を消さない安全側)。窓が進めば解消する。

### 7.8 監査なし → 監査ありへの切替(再監査)

監査なし期間の verified 行は、切り替えても自動では再監査されない。再監査するなら、
**最初の監査実行より前に**差し戻す。順序は次のとおりで、**入れ替えない**。

1. 監査準備(§3.3 の plist、Keychain、D1 API トークン)を済ませる。launchd はまだ
   `bootstrap` せず、監査も実行しない(§3.1 手順2の「手動で1回実行」もまだ行わない)。
2. `scores` をバックアップする(`id` と `created_at` を必ず含める)。
3. `RANKING_AUDIT_MODE` を `enabled` にして(Production 環境の変数を変更し、同じコミットを
   再デプロイする)反映し、1件投稿して §7.3 の SQL で新規行が `pending` で入ることを確認する。
4. 差し戻し SQL を流す(下記)。
5. `npm run ranking:remote:audit` を、pending が0になるまで手動で繰り返す。
6. 順位表を確認してから launchd を `bootstrap` する(§3.3 手順7)。
7. (任意)手順2のバックアップから、verified に戻った行の元の `created_at` を戻す。

手順2のバックアップ。手順7に必要なのは `id` と `created_at` だけなので、まずこれを取る。
行全体が必要なら `wrangler d1 export`(wrangler 3.114.17 に `--remote` / `--table` /
`--no-schema` / `--output` がある)で SQL ダンプも取る。どちらのファイルもリポジトリの外に置き、
ダンプは `ip_hash` / `submitter_hash` を含むので共有しない。

```sh
npx wrangler d1 execute qixxx-scores --remote --json --command \
  "SELECT id, created_at FROM scores WHERE status = 'verified'" > scores-created-at-backup.json

# (任意)行全体
npx wrangler d1 export qixxx-scores --remote --table scores --no-schema --output scores-backup.sql
```

手順4の差し戻し SQL:

```sql
UPDATE scores
SET status = 'pending', audit_attempts = 0, next_attempt_at = NULL,
    submitter_hash = NULL, created_at = unixepoch() * 1000
WHERE status = 'verified'
  AND season_id = <CURRENT_SEASON_ID>
  AND ruleset_version = <RULESET_VERSION>
  AND replay_format_version = <REPLAY_FORMAT_VERSION>;
```

各条件の理由:

- **`created_at` を現在時刻にする**: 監査は冒頭で `created_at <= now - 72h` の pending を
  検証せずに削除する。古い行を元の日時のまま pending に戻すと、監査されずに消える。
  元の投稿日時は失われるので、手順7で戻せるようにバックアップを取る。
- **3つの版(シーズン・ルールセット・リプレイ形式)で絞る**: 旧シーズンや旧フォーマットの
  行を pending にすると、監査が版の不一致として削除する。
- **期間で絞らない**: 監査済みの行を再監査しても、同じ結果で verified に戻るだけ。監査なし
  期間を示す列や記録が要らず、migration も不要になる。
- **`submitter_hash = NULL`**: 再監査待ちの行が、新しい投稿の自己置換で消えないようにする。

差し戻し中の副作用(手順4〜5の間。数分で終わるよう手順5を続けて行う):

- `entries`(確定 TOP10)が空になり、事前ゲートの閾値が -1 に下がる。
- 表示(`displayEntries`)は pending の上位最大3件だけになる。
- 差し戻した行が pending の上限(全体200・IP あたり3)に数えられ、監査が終わるまで
  新規投稿が 429 になり得る。

監査は正しいリプレイを verified に戻し(スコア・ステージ・tick 数は再シミュレーション値で
上書き、`submitter_hash` は `NULL`)、申告スコアがリプレイと一致しない行を削除する。

手順7(任意)。バックアップから行ごとの UPDATE を作って流す。監査で削除された行や、
その後 pending で入った行は `status = 'verified'` の条件で対象外になる。

```sql
UPDATE scores SET created_at = <ORIGINAL_CREATED_AT> WHERE id = '<ID>' AND status = 'verified';
```

```sh
jq -r '.[0].results[] | "UPDATE scores SET created_at = \(.created_at) WHERE id = '\''\(.id)'\'' AND status = '\''verified'\'';"' \
  scores-created-at-backup.json > restore-created-at.sql
npx wrangler d1 execute qixxx-scores --remote --file restore-created-at.sql
```

**再監査しない場合**は、差し戻しの代わりに §7.4 の SQL で `submitter_hash` を消し、
最初の監査で現行シーズンの verified 11位以下が削除されることを受け入れてから、§3.1 の順で
監査を導入する。
