# Cloudflare Pages セットアップ手順（あなたの操作分）

docs/plan-cloudflare-x-share.md Phase 3 のうち、Cloudflare ダッシュボードでしか行えない作業の手順書。コード側（ビルド出力・Functions・`_redirects`・`wrangler.toml`）はすべてリポジトリに入っているので、ここの手順だけで本番が立ち上がる。

## 1. Pages プロジェクト作成（GitHub 連携）

1. Cloudflare ダッシュボード → **Workers & Pages** → **Create** → **Pages** → **Connect to Git**
2. GitHub 認可で **shimabox/qixxx** を選択（private リポジトリのままで OK）
3. ビルド設定:
   - **Production branch**: `main`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
   - 環境変数: 不要（Node バージョン指定が要る場合のみ `NODE_VERSION=20`）
4. Save and Deploy → 一度目のビルドが走る（`*.pages.dev` の URL が発行される）

> フィーチャーブランチに push すると自動で **プレビューデプロイ**（ブランチ別 URL）が作られる。本番反映は main へのマージ。

## 2. KV ネームスペース作成（シェア機能に必須）

1. **Workers & Pages** → **KV** → **Create namespace** → 名前は例: `qixxx-shares`
2. 作成された namespace の **ID**（32 桁）を `wrangler.toml` の `[[kv_namespaces]]` の `id` に設定する（設定済み: `6c911969...`）

> **注意（2026-07-10 の実デプロイで判明）**: `wrangler.toml` を持つ Pages プロジェクトでは**同ファイルがバインド設定の正**になり、ダッシュボードで追加したバインドより優先される。バインドをダッシュボードで設定する必要はなく、namespace の「作成」と「ID の転記」だけでよい。ID を差し替えたら push（= 再デプロイ）で反映される

## 3. カスタムドメイン割り当て

1. Pages プロジェクト → **Custom domains** → **Set up a custom domain**
2. `qixxx.orukubami.sh` を入力（ゾーン orukubami.sh は Cloudflare 管理なので DNS レコードは自動作成される）
3. 有効化後、`https://qixxx.orukubami.sh/` でゲームが直接開けることを確認（サブドメインのルートで配信、パスプレフィックスなし）

## 4. Web Analytics 有効化（Pages の自動注入を使う）

1. **qixxx プロジェクト → Settings → Metrics（Web Analytics）→ Enable**
2. これだけ。Cloudflare が配信時にビーコンを自動注入するため、**リポジトリへのタグ追加は不要**

> 当初は「index.html に計測タグをコミットする」計画だったが、OSS 公開時に fork 先のデプロイからも自分の解析へデータが流れ込む問題があるため、自動注入方式に変更（2026-07-11）。トークン自体は配信 HTML に埋まる公開情報であり秘密ではない

## 5. 動作確認チェックリスト（全部そろったら）

- [ ] `https://qixxx.orukubami.sh/` でゲームが遊べる
- [ ] ゲームオーバー → POST TO X → X の投稿画面が開き、URL 付きツイートが作れる
- [ ] そのツイート（または https://cards-dev.twitter.com 相当の検証ツール / 実投稿）でスコア入り OG カードが表示される
- [ ] `https://qixxx.orukubami.sh/s?id=適当な文字列` が 404 になる（偽造不可の確認）

## 補足

- **GitHub Pages は撤去済み**（deploy.yml 削除・リポジトリ設定の Pages 無効化）。デプロイは Cloudflare のみ。
- ローカルで本番相当を試すには: `npm run build && npm run pages:dev` → `http://localhost:8788/`（KV はローカルエミュレーション、`.wrangler/` に保存・gitignore 済み）。
- KV バインドは `wrangler.toml` が正(手順 2 の注意参照)。ローカルの `wrangler pages dev` は ID に関係なくローカルエミュレーション（`.wrangler/`）を使う。
- 旧 `app.orukubami.sh/qixxx/...`（パスベース、`orukubami-hub` Worker 経由）からこのサブドメイン方式への移行に伴い、旧URLへの後方互換リダイレクトは設けていない（方針として割り切り）。
