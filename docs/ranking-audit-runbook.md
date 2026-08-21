# スコアランキング Free 版(非同期監査)運用手順書

`plan/2026-08-19-ranking-free-async` ブランチで試作した非同期監査方式の運用手順。
Paid 版(同期検証)の運用は [`docs/ranking-runbook.md`](./ranking-runbook.md) を参照
(D1 スキーマの基礎・シーズン切替・検証ルール変更はそちらと共通)。

関連ファイル:

- 追加スキーマ: [`migrations/0002_ranking_free_async.sql`](../migrations/0002_ranking_free_async.sql)
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
POST /api/scores ─→ 基本検査 + 圏内事前ゲート ─→ D1 に status='pending' で保存 ─→ 即応答
                                                          │
                                                          ▼
                                    scripts/audit/runAudit.ts (Node, 手動 or GitHub Actions)
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

### 0.1 表示契約・24時間境界・リプレイ判定順(2026-08-20 改訂)

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

### 0.2 pending 自己置換(ブラウザ所有権)(2026-08-22 追加)

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

## 1. ローカルでの手動実行手順(このラウンドで動作確認済み)

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
意図的に中断している**。リース10分 > 最大実行時間5分(spec item 8)の設計上
本来起きないはずの状態なので、起きたら実行時間・D1 の応答遅延を確認すること。
未処理分は次回実行が引き継ぐため、DB 自体は壊れていない
(中断後の書き込みはフェンシングで一切適用されない)。

確定した行は `GET /api/ranking` の `entries`(確定 TOP10)に現れ、`displayEntries`
では同じ順位のまま `status` が `"pending"` から `"verified"` に変わる(順位は動かず
UI の VERIFYING バッジだけが消える)。`GET /api/ranking/:id/replay` は pending の
間も 200 で見られる(応答に `status:"pending"` が含まれ、ビューアが VERIFYING を
常時表示する)。404 になるのは「行が無い/監査で削除済み」か「pending かつ期限切れ
(`created_at <= now-24h`)」の場合のみ。

### 1.4 偽スコアの削除を確認する

`score` に実際のシミュレーション結果と異なる値を入れて POST すると、
`accepted:true` で一旦 pending になり、`GET /api/ranking` の `displayEntries` に
`status:"pending"` の行として(スコア順の本来の位置に)表示される。監査を実行すると `verifyPendingEntry()` が `declared-score-mismatch`
と判定して即削除される(`entry-deleted-confirmed-invalid` イベント、
`reason:"declared-score-mismatch"`)。

このラウンドの実装時に上記 1.2〜1.4 の一連を実機(`wrangler pages dev` + 実 D1 +
`scripts/audit/cli.ts`)で確認済み(完了報告の「実機確認結果」参照)。

---

## 2. D1 スキーマ(このラウンドで追加した列)

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

---

## 3. GitHub Actions での定期実行を有効化する手順(未実施・本番接続後の作業)

`.github/workflows/ranking-audit.yml` は現状 `workflow_dispatch` のみ有効。
`schedule` はコメントアウトされている(理由はワークフローファイル自身のコメントを参照)。
有効化には以下がすべて必要:

1. **本番 D1 への接続を実装する**(このラウンドの範囲外)。
   `scripts/audit/d1Adapter.ts` の `RemoteD1Adapter` が現状 throw するだけの
   スタブになっている — 実装時の選択肢は次の2つ:
   - `wrangler d1 execute --remote` をシェルアウトして呼ぶ(Actions 上で
     `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` を secret として渡す)
   - D1 の REST API を直接 `fetch` する(Cloudflare API トークンで認証)
   どちらも「Actions から D1 への認証・接続」という同じ論点で、
   ローカル監査スクリプトの `getPlatformProxy()` とは別の実装になる。
2. リポジトリ変数 `AUDIT_CRON_ENABLED` を `true` に設定
   (Settings → Secrets and variables → Actions → Variables)。
3. ワークフローファイルの `schedule:` ブロックのコメントアウトを外す。
4. リポジトリ secret `RANKING_IP_HASH_KEY` を、本番の Cloudflare Pages secret と
   **同じ値**で設定する(Settings → Secrets and variables → Actions → Secrets)。
   値が食い違うと、監査ジョブは動くが ip_hash の意味論とは無関係(このラウンドの
   audit コマンドは ip_hash を再計算しない — POST 時に確定済みの値を読むだけ)
   なので実害はないが、鍵管理の一貫性のため揃えておくこと。

## 4. ip_hash 鍵の管理

- アルゴリズム: HMAC-SHA-256(固定)。生 IP は保存しない。固定ソルト付き SHA-256 は不可
  (IP は低エントロピーで公開ソルトでは総当たり可能なため)。
- ローカル: `.dev.vars`(gitignore 済み。`.dev.vars.example` を雛形として使う)。
- 本番: Cloudflare Pages の secret(`wrangler pages secret put RANKING_IP_HASH_KEY`)。
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

## 6. 既知の残余リスク・未決事項

- Actions からの実 D1 接続方式(§3 の1)は未実装・未決定。
- Free 10ms CPU 適合の最終確定(実測 `cpuTime`)は本ラウンドのスコープ外
  — デプロイ判断後の Cloudflare preview 環境での実測に委ねる。
- 監査までの偽スコア表示窓(通常運用で cron 間隔+実行時間、リトライ対象は最大3周期まで。
  GitHub Actions の `schedule` は遅延・スキップされ得るため、いずれも保証値ではなく目安)
  は非同期監査方式の本質的なトレードオフであり、実装で解消できるものではない
  (Paid 版との比較観点として完了報告に記載)。2026-08-20 改訂により pending は
  `displayEntries` に統合表示されるため、この窓の間、偽スコアは表示上の実際の順位を
  一時的に占有し得る(占有は最大3行。投稿の受理可否は `entries` 基準の事前ゲートのみに
  依存するため、正当な投稿が妨害されることはない)。
