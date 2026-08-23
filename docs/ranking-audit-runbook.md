# スコアランキング Free 版(非同期監査)運用手順書

スコアランキング Free 版で採用している非同期監査方式の運用手順。
Paid 版(同期検証)の運用は [`docs/ranking-runbook.md`](./ranking-runbook.md) を参照
(D1 スキーマの基礎・シーズン切替・検証ルール変更はそちらと共通)。

関連ファイル:

- 追加スキーマ: [`migrations/0002_ranking_free_async.sql`](../migrations/0002_ranking_free_async.sql)、[`migrations/0004_ranking_rate_limits.sql`](../migrations/0004_ranking_rate_limits.sql)
- POST ハンドラ: [`functions/api/scores.ts`](../functions/api/scores.ts)
- GET ハンドラ: [`functions/api/ranking.ts`](../functions/api/ranking.ts)
- 監査ロジック: [`scripts/audit/runAudit.ts`](../scripts/audit/runAudit.ts)
- 監査ロック: [`scripts/audit/lock.ts`](../scripts/audit/lock.ts)
- D1 接続アダプタ: [`scripts/audit/d1Adapter.ts`](../scripts/audit/d1Adapter.ts)
- CLI エントリポイント: [`scripts/audit/cli.ts`](../scripts/audit/cli.ts)
- GitHub Actions ワークフロー: [`.github/workflows/ranking-audit.yml`](../.github/workflows/ranking-audit.yml)

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
                           scripts/audit/runAudit.ts (Node, 手動 / launchd / GitHub Actions)
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

### 0.1 表示契約・24時間境界・リプレイ判定順

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

**24時間境界の統一定義**: `cutoff = now − 24時間` を全処理で共通に使い、
**新鮮 = `created_at > cutoff`**、**期限切れ = `created_at <= cutoff`** とする
(実装は `functions/_lib/ranking/pendingGate.ts` の `pendingFreshnessCutoff()` に
一本化。displayEntries 抽出・POST の上限 COUNT・リプレイ判定・監査の期限切れ削除の
4箇所すべてがこれを参照する)。verified はこの判定の対象外。

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
| 公開ランキングの閲覧者 | 順位表の静的注意書き「Scores are verified after posting; entries that fail verification are removed.」で、後から削除され得る運用を常時開示 |
| 投稿者本人 | 投稿完了時の「SUBMITTED — PENDING VERIFICATION」で監査待ちを伝える |
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
   異なる 24時間境界で件数を数えると「DELETE=1 / INSERT=0」が復活する。SQLite の単一ライター性が
   保証するのは batch 内の非交錯だけで、最初の試行と batch の間の状態変化は防がない。

`replay_hash` UNIQUE 違反等の**エラー**時は batch 全体がロールバックされ旧行は失われない。
置換候補が無ければ従来どおり 429(UI は SUBMIT を残しリトライ可能にする)。
3層分離(事前ゲート・`displayEntries`・監査)には一切影響しない。

検証は `functions/_lib/ranking/pendingSelfReplace.test.ts`(実 D1。全ケースで
「消えた行があるなら必ず1行増えている」不変条件を機械的に検査)と
`functions/_lib/ranking/scoresEndpoint.test.ts`(bind 値のアサート)。

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
(`created_at <= now-24h`)」の場合のみ。

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
| `ip_hash` | `TEXT`(nullable) | `HMAC-SHA-256(CF-Connecting-IP)`。既存行は `NULL`(生成当時この列がなかったため) |
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

Paid 同期検証へ切り替える際の必須チェック:

1. `verifyReplay()` を投稿内で同期実行する。
2. 新規行を最初から `verified` で保存する。
3. 切替前に既存 pending を監査して空にする。
4. pending の24時間期限、IP 3件、全体200件、自己置換を停止する。
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

| 環境変数 | GitHub Actions | launchd |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | Secret | Keychain |
| `CLOUDFLARE_ACCOUNT_ID` | Repository Variable | plist |
| `CLOUDFLARE_D1_DATABASE_ID` | Repository Variable | plist |
| `RANKING_IP_HASH_KEY` | Secret | Keychain |

`CLOUDFLARE_D1_DATABASE_ID` は `wrangler.toml` の `database_id` と一致させる。
API token は対象 account の D1 Write/Edit のみに絞る。これより広い Workers、Pages、
Account Settings、Zone 権限を要求される場合は両 scheduler を有効にせず、権限と接続先を確認する。

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

1. GitHub Actions の Secrets に `CLOUDFLARE_API_TOKEN` と `RANKING_IP_HASH_KEY`、
   Variables に `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_D1_DATABASE_ID`、
   `AUDIT_CRON_ENABLED=false` を登録する。secret 値は出力して比較しない。
2. 実装とは別の運用作業で `wrangler d1 migrations apply qixxx-scores --remote` を実行する。
   本番 migration は監査有効化前の必須依存であり、この実装の検証には含めない。
3. reviewed commit の checkout から `npm run ranking:remote:audit` を1回実行し、
   `done.`、`lockReleased=true`、既知 pending の確定または削除、ログの秘匿を確認する。
4. reviewed commit を main へマージする。
5. main の `workflow_dispatch` を実行し、同じ完了条件を確認する。main 以外では手動実行も job が開始されない。
6. §3.3 の launchd を導入し、通常周期とスリープ復帰を確認する。
7. 最後に `AUDIT_CRON_ENABLED=true` へ変更し、毎時23分の Actions バックストップを有効にする。

### 3.2 二つの scheduler

- 主系: launchd。毎時 2, 7, 12, …, 57 分の5分間隔。
- バックストップ: GitHub Actions。`23 * * * *`。main かつ手動、または
  `AUDIT_CRON_ENABLED=true` のときだけ実行する。

GitHub Actions の `concurrency.group` は `ranking-audit`、`cancel-in-progress` は
`false`。scheduler 間の排他は D1 の10分 lease、heartbeat、fenced write が担う。
300秒の retry delay は最小の通常起動間隔以下という目安で、正確な起動時刻を保証しない。

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

無効化・ロールバックでは最初に `AUDIT_CRON_ENABLED=false` と launchd の `bootout` を行う。
実行中 Actions job の終了と、`audit_lock` の解放または10分失効を確認する。remote adapter や
workflow を revert しても schema は DROP せず、verified 化や削除を自動で戻さない。

- Keychain failure: account/service 名、login Keychain の unlock/ACL、ラッパーの stderr を確認する。secret を plist やファイルへ退避しない。
- 401/403: token の対象 account と D1 Write/Edit 権限、account/database ID を確認する。権限を広げない。
- 429: 両 scheduler を止め、Cloudflare API の rate limit を確認する。自動 retry を追加しない。
- response error: 両 scheduler を止め、API 応答仕様と fixture の差を確認する。想定外 BLOB を成功扱いしない。
- lease loss: `leaseLostMidRun` / `lockReleased` と D1 遅延を確認する。10分 lease や5分 runtime を独断で変更しない。
- Mac 停止: Actions の毎時バックストップを確認し、復旧後の launchd 実行を確認する。
- Actions failure: main ガード、variable gate、Secrets/Variables、migration、job log の固定エラー名を確認する。
- token 漏洩疑い: Cloudflare token を失効・再発行し、GitHub Secret と Keychain の両方を更新する。

本番 migration 未適用、Pages/GitHub/Keychain の鍵一致を値の出力なしに確認できない、
数値 bind や BLOB が想定と異なる場合は scheduler を有効にせず運用者確認で停止する。

## 4. ip_hash 鍵の管理

- アルゴリズム: HMAC-SHA-256(固定)。生 IP は保存しない。固定ソルト付き SHA-256 は不可
  (IP は低エントロピーで公開ソルトでは総当たり可能なため)。
- ローカル: `.dev.vars`(gitignore 済み。`.dev.vars.example` を雛形として使う)。
- 本番: Cloudflare Pages の secret(`wrangler pages secret put RANKING_IP_HASH_KEY`)。
- 定期監査: GitHub Actions Secret と Keychain service `qixxx-ranking-audit`。Pages と同じ値を登録するが、値をログへ出して比較しない。
- 鍵が未設定の場合、POST ハンドラ・監査コマンドの両方が **DB 操作前に** 検出して
  fail-closed する(`functions/_lib/ranking/ipHash.ts`)。生 IP へのフォールバックはしない。

## 5. ログ方針(公開ログ前提)

**このリポジトリは公開されており、GitHub Actions の実行ログは誰でも閲覧できる。**
監査ジョブが出力するものは「運用者のコンソール」ではなく **公開された成果物** として扱う。
対象は `scripts/audit/cli.ts` の標準出力/標準エラー、`runAudit()` が emit する
`AuditEvent` 全種(cli がそのまま JSON で印字する)、および workflow の run ステップ出力。

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
— **workflow では絶対に設定しない**。

クラス名は**固定の許可リスト**(`ALLOWED_ERROR_NAMES`)と照合し、載っていない名前は
すべて `UnknownError` にする。`Error#name` は書き換え可能なただのプロパティなので、
「識別子の形をしている」ことは本物のクラス名である証拠にならない
(`{name:"Secret_supersecret"}` がそのまま公開ログに出てしまう)。
許可リストに足すのは **どこで throw されるかを確認したクラスだけ**。
未収載のクラスは `UnknownError` になるが、それはローカル再実行1回で特定できる
コストであり、素性不明の文字列を公開する損失とは釣り合わない。

### 5.2 エントリポイントの構造(初期化例外の取りこぼし防止)

`scripts/audit/cli.ts` は **最小の bootstrap** であり、コマンド本体は
`./auditCommand` を **動的 import** して読み込む。静的 import にすると
**モジュール初期化中の throw** が bootstrap の catch より前に発生し、
vite-node が生スタック(絶対パス込み)を公開ログに出してしまうため
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
- 監査までの偽スコア表示窓(通常運用で cron 間隔+実行時間、リトライ対象は最大3周期まで。
  GitHub Actions の `schedule` は遅延・スキップされ得るため、いずれも保証値ではなく目安)
  は非同期監査方式の本質的なトレードオフであり、実装で解消できるものではない
  (同期検証を行う Paid 版にはこの窓がない)。pending は `displayEntries` に
  統合表示されるため、この窓の間、偽スコアは表示上の実際の順位を
  一時的に占有し得る(占有は最大3行。投稿の受理可否は `entries` 基準の事前ゲートのみに
  依存するため、正当な投稿が妨害されることはない)。
