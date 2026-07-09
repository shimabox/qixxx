# QIXXX 拡張プラン — Cloudflare 移行 + スコアシェア（2026-07-09）

Cloudflare へのホスティング移行と、GAME OVER 時のスコアモーダル + X（旧 Twitter）シェア機能の計画書。ユーザーとの確認（2026-07-09〜10）で方針が確定した内容をまとめる。実装は従来どおりサブエージェントへ委譲し、オーケストレーターが検証する体制で進める。

**ステータス**: 計画確定（2026-07-10 レビュー済み: 懸念点の対応方針を反映）・未着手。リポジトリは現在 private。

---

## 第 1 部: わたし（ユーザー）がやろうとしていること

### 背景・動機

- 現在 QIXXX は GitHub Pages（`https://shimabox.github.io/qixxx/`）で公開している。
- 「ごそっと修正したい」ため、いったんリポジトリを private 化済み（無料プランのため GitHub Pages は現在オフライン）。
- Cloudflare で独自ドメイン `orukubami.sh` を取得済み。これを使って自分のドメイン配下で配信したい。
- あわせて、プレイ結果（スコア）を X でシェアできる導線を付けて、遊んだ人が結果を投稿できるようにしたい。

### やりたいこと 3 点

1. **ホスティングを Cloudflare へ移行**
   - `app.orukubami.sh/qixxx` でプレイできるようにする。
   - ドメイン `orukubami.sh` は Cloudflare 管理。

2. **GAME OVER 画面にスコアモーダルを付ける**
   - その時のスコア情報（スコア・ハイスコア・到達ステージ）を表示する。
   - ゲームは**スコアアタック型（無限継続）**。ステージをクリアするたびに次の（より難しい）面へ進み、1プレイは**ライフが尽きた GAME OVER で終わる**。勝ち切る「エンディング」は作らない。
   - モーダルは **GAME OVER のときだけ**出す。毎回のステージクリア画面は今のまま「次の面へ」でよい（スコアが確定するのが GAME OVER のため）。

3. **X へスコアをシェアする機能**
   - GAME OVER モーダルから X に投稿でき、投稿にスコア入りの **OG 画像カード**が出るようにしたい。

### 確定した決定事項（2026-07-09 の確認回答）

| 論点 | 決定 |
|---|---|
| Cloudflare デプロイ方法 | **ダッシュボード連携**（Cloudflare ダッシュボードで GitHub リポジトリを接続し、push で自動ビルド） |
| GitHub Pages | **廃止して Cloudflare に一本化** |
| ゲームの終わり方 | **エンディングなし・スコアアタック型（無限継続）**。1プレイは GAME OVER で終了 |
| モーダル/シェアを出す場面 | **GAME OVER のときだけ**（ステージクリア画面は現状のまま「次の面へ」） |
| スコア偽装対策 | **対策なし**（スコアは URL パラメータのまま。ランキングも賞品も無い自慢用シェアなので割り切り） |
| 難易度カーブ | **現状維持（変更なし）**。「20 面で頭打ち」案も検討したが、序盤が簡単すぎると単調になるため 10 面頭打ちの現行カーブを据え置き（2026-07-09 決定）。シェア導入後の実データを見て必要なら天井だけ config で緩める |
| OG カード画像内の文字 | **英数字のみ**（STAGE / SCORE / HI SCORE — ゲーム HUD と同じ英字表記）。Functions のサイズ上限内に収めるため。ツイート本文は日本語（2026-07-10 決定） |
| ツイート文面 | デフォルト案で確定: 「QIXXX で STAGE {n} / SCORE {score} を記録！ #QIXXX」＋シェア URL（実物を見て微調整可） |
| ルート URL の扱い | `app.orukubami.sh/` へのアクセスは **`/qixxx/` へリダイレクト**（`_redirects` 1 行） |
| アクセス解析 | **Cloudflare Web Analytics を入れる**（無料・クッキーなし）。訪問数・シェア流入の把握と、「何面で終わる人が多いか」等の難易度調整の実データに使う |

---

## 第 2 部: それに対するプラン（オーケストレーターの実装計画）

### 全体アーキテクチャと、なぜ Cloudflare なのか

X にリンクを貼ったとき「スコアごとに違う画像カード」を出すには、リンク先が **サーバ側で動的に OG メタタグと画像を生成**する必要がある（X のクローラーは JS を実行せず、初期 HTML の `og:image` を読むだけ）。

- **GitHub Pages（静的のみ）ではこれは不可能** — 全員同じ固定画像しか出せない。
- **Cloudflare Pages には Functions（= Workers）が付属**しており、エッジで動的 HTML/画像を生成できる。

つまり「やりたいこと 1（Cloudflare 移行）」と「やりたいこと 3（スコア入り OG カード）」は技術的に噛み合っており、Cloudflare へ移すことで 3 が自然に実現できる。この 2 つはセットで進める。

配信構造（`app.orukubami.sh/qixxx`）:

- `vite.config.ts` の `base` は既に `/qixxx/` なので流用できる。
- Cloudflare Pages は「ドメイン単位」でプロジェクトに紐づくため、`app.orukubami.sh` をこのプロジェクトのカスタムドメインに割り当て、**ビルド成果物を `qixxx/` サブフォルダに配置**して `/qixxx/` で配信する。
- Functions はリポジトリ直下の `functions/` に置き、`functions/qixxx/s.ts` → ルート `/qixxx/s`、`functions/qixxx/og.ts` → `/qixxx/og` のようにマッピングされる。静的アプリ（`/qixxx/`）と Functions（`/qixxx/s`, `/qixxx/og`）は同一プロジェクト内で共存できる。

---

### Phase 1: GAME OVER モーダル + 「Xでシェア」ボタン

**ローカルで完結・すぐ着手可能。Cloudflare 不要。**

- 現状は `#screen` オーバーレイ div にテキスト（TITLE / STAGE CLEAR / GAME OVER）を表示している。**GAME OVER のときだけ**、そこに**スコア情報を表示するモーダル**を重ねる。ステージクリア画面は今のまま（「次の面へ」）変更しない。
- 表示内容: 到達 STAGE / SCORE / HI SCORE（`session.getStage()` / `getScore()` / `getHighScore()` から取得。core 側の変更は不要）。
- **「PRESS ANY KEY」との共存（設計注意）**: 現行の GAME OVER 画面は任意キー/タップで即タイトルに戻るため、モーダルを出してもキー入力で消えてしまい、シェアボタンを押す前に誤って閉じやすい。対応: モーダルに **「Xでシェア」と「タイトルへ」の 2 ボタン**を置き、従来のキー操作でも戻れる形で共存させる（キーボード派の体験は不変、ボタン操作でも完結できる）。モーダル上のボタンクリックが誤って confirm（タイトル遷移）を発火しないことを確認する（tap-to-confirm はキャンバスのみに付いているため原理上は安全）。
- 「Xでシェア」ボタンは X の intent URL を開くだけ（**X API キー・OAuth 不要**）。スコアは1プレイの最終スコア:
  `https://twitter.com/intent/tweet?text=<スコア文>&url=https://app.orukubami.sh/qixxx/s?score=<score>&stage=<stage>&hi=<hi>`
- **core 純粋性は維持**（モーダルは DOM 層 = main.ts / 新設 ui モジュールのみ。`src/core/` は触らない）。
- 注意: Phase 2 デプロイ前は共有 URL 先が未実装なのでカードは出ないが、ボタン自体の動作（intent 画面が開く・文面と URL が正しい）はローカルで確認できる。

**受け入れ基準**: GAME OVER でモーダルが出てスコアが正しく表示される。「Xでシェア」で正しい文面・URL の intent 画面が開く。ステージクリアの挙動は不変。既存テスト・E2E 通過。60fps 維持。core 純粋性 grep 通過。

---

### Phase 2: Cloudflare Pages Functions（スコア入り OG カード生成）

**私が実装。動作確認はデプロイ後（Phase 3 で Cloudflare につながってから）。**

Functions を 2 本追加する。

1. **`/qixxx/s`（シェア用 HTML）**
   - クエリ `?score&stage&hi` を読み、`og:title` / `og:description` / `og:image`（= `/qixxx/og?...` を指す絶対 URL）/ `twitter:card=summary_large_image` を含む HTML を返す。
   - 人間がクリックした場合は本体ゲーム `/qixxx/` へ誘導。**meta refresh は使わず、JS リダイレクト＋手動リンク**にする（X のクローラーは JS を実行しないためメタタグを確実に読み、meta refresh のようにクローラーの解釈が不安定な手段を避ける）。

2. **`/qixxx/og`（OG 画像 PNG 生成）**
   - クエリを読み、スコア入りの画像（1200×630）を動的生成。
   - 実装: `workers-og`（Satori + resvg-wasm）で JSX ライクに描画。
   - **サイズ制約（最重要の技術リスク）**: Cloudflare の Functions にはスクリプトサイズ上限（無料プランで圧縮後 ~3MB）があり、workers-og の WASM だけで 1MB 超を占める。**カード内の文字は英数字のみ（決定事項）**とし、軽量な欧文等幅フォント 1 つ（**OFL ライセンスで再配布可能なもの**、例: JetBrains Mono / Press Start 2P 系、数十 KB）だけを同梱して上限内に収める。日本語フォント同梱（数 MB）はこの制約により不可。
   - デザイン: ゲームと同じネオン配色のカードに QIXXX ロゴ的タイトル + SCORE / STAGE / HI を配置（確定した文面プレビュー参照）。

- 依存追加: `workers-og`、欧文フォントアセット 1 つ。
- **偽装対策なし（決定事項）**: スコアは URL パラメータそのままなので、その気になれば偽装可能。お遊び機能として割り切る。
- 静的アセットと Functions の共存: Cloudflare Pages は URL に一致する静的ファイルがあればそれを優先し、無ければ Functions を呼ぶ。`/qixxx/s`・`/qixxx/og` に静的ファイルは存在しないため衝突しない。
- 注意: X はカードをキャッシュするため、テスト時は X の Card Validator で更新する。スコアごとに URL が変わるので実運用では概ね問題ない。

**受け入れ基準**: `/qixxx/s?score=...&stage=...` を X に貼るとスコア入りカードが表示される。人間がクリックすると本体ゲームに到達する。

---

### Phase 3: ホスティング移行の本番化（GitHub Pages 廃止 → Cloudflare 一本化）

**私（コード側）＋ あなた（Cloudflare ダッシュボード操作）。**

私が用意するもの:

- ビルド出力構造の調整（`/qixxx/` サブパスで配信されるよう、Vite の `build.outDir` を `dist/qixxx` 等に設定し、Pages の出力ディレクトリを `dist` にする）。
- `_redirects` ファイル: ルート `/` → `/qixxx/` のリダイレクト（決定事項）。
- GitHub Pages 撤去: `.github/workflows/deploy.yml` を削除し、リポジトリ設定の Pages を無効化。CI（`ci.yml`: lint/typecheck/test/build/e2e）は維持。
- **ドキュメントの URL 差し替え**: README・how-to-play 等に残る旧 URL（`shimabox.github.io/qixxx`）を `app.orukubami.sh/qixxx` に更新。plan.md §2 のデプロイ欄も Cloudflare Pages に更新。
- **Cloudflare Web Analytics の計測タグを追加**（決定事項。index.html に 1 行）。
- Cloudflare 側のビルド設定と手順書（ビルドコマンド `npm run build`、出力ディレクトリ、Functions 構成、カスタムドメイン割り当て手順）。

あなたにお願いする操作（私はアカウントに入れないため）:

- Cloudflare ダッシュボードで **GitHub リポジトリを Pages プロジェクトに接続**（private リポジトリでも可）。
- カスタムドメイン **`app.orukubami.sh` を割り当て**（DNS は Cloudflare 管理なので自動で通る）。
- **Web Analytics をダッシュボードで有効化**し、発行されたトークンを共有（タグに埋めるため）。

**受け入れ基準**: `app.orukubami.sh/qixxx` で本番プレイ可能。push で自動ビルド・デプロイ。GitHub Pages は停止。

---

### 担当整理

| フェーズ | 私（オーケストレーター＋サブエージェント） | あなた |
|---|---|---|
| Phase 1 モーダル+シェアボタン | 実装・ローカル検証 | 文面/デザインの確認 |
| Phase 2 OG Functions | 実装 | デプロイ後の見た目確認 |
| Phase 3 移行 | ビルド設定・GH Pages 撤去・手順書 | リポジトリ接続・ドメイン割り当て |

### 実装順の依存関係

- Phase 1 は独立・ローカルで完結 → **最初に着手可能**。
- Phase 2 はコードは先に書けるが、動作確認は最初の Cloudflare デプロイ後。
- Phase 3 はあなたのダッシュボード操作が必要 → これが済むと Phase 2 のテストと本番公開が解禁される。

---

### 確定済みの「外向きの中身」（2026-07-10）

1. **ツイート文面（確定・微調整可）**

   ```
   QIXXX で STAGE 12 / SCORE 45,600 を記録！ #QIXXX
   https://app.orukubami.sh/qixxx/s?score=45600&stage=12&hi=45600
   ```

2. **OG カード（確定・微調整可）**: ゲームと同じネオン配色。文字は英数字のみ。

   ```
   ┌────────────────────────┐
   │  QIXXX                 │
   │  SCORE  45,600         │
   │  STAGE  12             │
   │  HI     45,600         │
   └────────────────────────┘
   ```

### 残る要検討の小項目

- OG フォントの具体選定（OFL の欧文等幅系から実装時に選ぶ。ライセンスファイル同梱）。
- ハイスコア更新時にカードへ「NEW RECORD」表示を入れるか（実装時のお楽しみ枠・任意）。
