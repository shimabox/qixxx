# QIXXX（キックス）

[![PLAY NOW](https://img.shields.io/badge/%E2%96%B6_PLAY_NOW-qixxx.orukubami.sh-blue?style=flat-square)](https://qixxx.orukubami.sh/)
[![X @shimabox](https://img.shields.io/badge/%40shimabox-000000?style=flat-square&logo=x&logoColor=white)](https://x.com/shimabox)

線を引いて陣地を切り取る、ネオン風の陣取りアクションゲーム。  
1981 年のアーケードゲーム QIX へのオマージュとして、メカニクスは原作準拠・名称やビジュアルはオリジナルで作られています。

![プレイ画面。左の赤が低速ライン（高得点）、右上と右下の青が高速ラインで取った陣地。中央の黄色が引き途中のライン。紫の点がウィスプ、枠の上のオレンジの点がエンバー](docs/images/readme-playing.png)

敵に触れないようにフィールドへラインを引き、**占有率が目標値に達したらステージクリア**。
目標値はステージ 1 が **65%**、ステージが進むごとに少しずつ上がり、ステージ 10 で最大の **90%** になります。敵（ウィスプ）もステージごとに増え、ステージ 10 で最大の **10 匹**に到達します（速度・出現間隔なども同時に最大まで上昇し、11 面以降はその最大値のまま据え置きです）。
敵が 2 匹以上いるステージでは、ラインで敵同士を**分断**すると占有率に関係なく即クリア（一発逆転の大技）。
デスクトップ（キーボード）とスマホ（タッチ）の両方で遊べます。

ゲームオーバー時には、そのプレイのスコアを **X（旧 Twitter）にシェア**できます。スコア入りのカード画像付きで投稿されます。

![X シェア時に生成されるスコアカード](docs/images/readme-share-card.png)

スコアが **TOP 10** に入る見込みのときは、ゲームオーバー画面から名前または X ハンドルを添えて **オンラインランキングに投稿**できます。タイトル画面の **RANKING** ボタンで上位 10 件を確認でき、各エントリの **REPLAY** でそのプレイを最初から再生して見られます。

![ランキング一覧。順位・スコア・到達ステージ・名前が並び、各行に REPLAY ボタンがある](docs/images/ranking-list.png)

**➡️ 詳しいルールと遊び方: [遊び方ガイド](docs/how-to-play.md)**

## 遊ぶ

**🎮 ブラウザですぐ遊べます: https://qixxx.orukubami.sh/**

ローカルで動かす場合:

```bash
npm install
npm run dev
```

表示された URL（例: `http://localhost:5173/`）をブラウザで開き、何かキーを押す（タップする）とスタートします。タイトル画面では、右上の **RANKING** ボタンからランキングを開けます。

![タイトル画面](docs/images/readme-title.png)

> 🔊 **効果音があります（初回はミュート）。** 画面右上の **UNMUTE ボタン**を押すと、ライン引き・エリア確定・ミスなどに合わせて音が鳴ります。設定は保存され、次回以降も引き継がれます。

### 基本操作（デスクトップ）

| 操作 | キー |
|---|---|
| 移動 | 矢印キー / `H` `J` `K` `L`（Vim 風） |
| 高速ライン | `X` / `Space` を押しながら移動 |
| 低速ライン（2 倍得点） | `Z` / `Shift` を押しながら移動 |

スマホでは画面下部の仮想十字キーと `FAST` / `SLOW` ボタンで操作します。

> ⚠️ **キーが効かないときは:** Vimium などのブラウザ拡張が `H` `J` `K` `L` `X` `Z` といった文字キーを横取りしている可能性があります（矢印キーと Space だけ効くのが典型的な症状）。**シークレットウィンドウで開く**か、拡張の除外サイトにこのゲームの URL を追加してください。日本語入力（IME）が ON の場合も同様なので、英数モードでプレイしてください。

## 技術スタック

- TypeScript (strict) + Canvas 2D — フレームワーク・ゲームエンジン不使用
- Vite（開発・ビルド） / Vitest（ユニットテスト） / Playwright（E2E スモーク）
- 効果音は Web Audio API による実行時生成（音源アセットなし）
- ホスティングは Cloudflare Pages（qixxx.orukubami.sh）
- X シェアのスコアカードは Cloudflare Pages Functions + Workers KV + workers-og（Satori）でエッジ動的生成
- スコアランキング（投稿・TOP 10・リプレイ）は Cloudflare Pages Functions + **Cloudflare D1** に保存。リプレイは投稿時の入力記録をクライアント側で再生

コアロジック（`src/core/`）は DOM・Canvas 非依存の純 TypeScript で、ユニットテストで網羅しています。

## 開発コマンド

```bash
npm run dev        # 開発サーバ起動
npm run build      # プロダクションビルド（dist/）
npm test           # ユニットテスト（Vitest）
npm run e2e        # E2E スモークテスト（Playwright）
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
```

### デバッグパネル（開発用）

開発サーバで URL に `?debug` を付けると、敵の数・速度・出現間隔・要求占有率などをスライダーで即時調整できるパネルが出ます（プロダクションビルドには含まれません）。`EXPORT` でチューニング結果を JSON として書き出せます。

![デバッグパネル。Wisp を 3 体に増やしたところ](docs/images/readme-debug.png)

## ディレクトリ構成

```
src/
├── core/     # ゲームロジック（DOM 非依存・テスト対象の中心）
├── render/   # Canvas 描画
├── input/    # キーボード・タッチ入力
├── audio/    # Web Audio 効果音
├── storage/  # localStorage（ハイスコア・設定）
├── config.ts # チューニング定数・配色
├── ui/       # GAME OVER モーダル（X シェア・スコア投稿）、ランキング一覧・リプレイ UI
└── main.ts   # エントリポイント（結線・ゲームループ）
functions/    # Cloudflare Pages Functions（シェア API・OG カード生成・ランキング API）
docs/
├── plan.md                   # 実装計画書
├── how-to-play.md            # 遊び方ガイド
├── cloudflare-setup.md       # Cloudflare 環境構築
├── ranking-schema.md         # ランキングの D1 スキーマ
├── ranking-runbook.md        # ランキング運用手順書（削除・シーズン・ルール変更）
├── ranking-audit-runbook.md  # リプレイ監査の手順書
└── images/                   # 文書用スクリーンショット
```

## ライセンス

[MIT](LICENSE)
