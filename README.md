# Lago 従量課金シミュレーター PoC

月額固定・従量課金・前払いクレジットの3プランを Lago 上に作り、**同じ顧客利用データ**を流して請求額を比較する。
あわせて、請求額を独自に計算した期待値と Lago の請求書を突き合わせ、Lago が請求の複雑さをどこまで肩代わりするかを確かめる。

## 結論

- 9ケース(3顧客像 × 3プラン)すべてで、Lago の請求書は独自計算の期待値と **1円単位で一致**した。
- プランの違いは Lago 上の設定だけで表現でき、イベント送信側のコードはプランを一切意識しない。
- 一方で「入金の反映」「不正イベントの検知」「重複送信時の再送」は呼び出し側に残る(下記)。

### 当月の支払総額(税込、2026-11-15 実行)

| 顧客 | API呼び出し | トークン | 月額固定 | 従量課金 | 前払いクレジット | 最安 |
|---|--:|--:|--:|--:|--:|---|
| ライト | 200 | 227,935 | ¥33,000 | ¥2,640 | ¥20,000 (残高 ¥19,360) | 従量課金 |
| スタンダード | 1,500 | 2,395,168 | ¥33,000 | ¥20,108 | ¥20,000 (残高 ¥1,892) | 前払いクレジット |
| ヘビー | 6,001 | 12,050,270 | ¥33,000 | ¥64,818 | ¥62,818 (残高 ¥0) | 月額固定 |

請求書ごとの内訳と照合結果は `npm run simulate` が [out/report.md](out/report.md) に出力する。

## シナリオ

定義はすべて [src/scenario.ts](src/scenario.ts) にある。通貨は JPY、消費税 10%。

| プラン | 基本料 | API呼び出し | AIトークン |
|---|--:|---|---|
| 月額固定 | ¥30,000 | ¥0(利用量は請求書に載せる) | ¥0 |
| 従量課金 | ¥0 | 段階料金: 〜1,000件 ¥12 / 〜4,000件 ¥8 / 以降 ¥4.5 | 10万トークンごと ¥120、50万まで無料 |
| 前払いクレジット | ¥0 | 従量課金と同じ | 従量課金と同じ |

前払いは ¥20,000 分の購入で 10%(¥2,000 分)のボーナスが付き、請求時に残高から充当される。
単価を従量課金と揃えたのは、差をウォレットの効果だけに絞るため。

利用データはシード付きで決定的に生成する。API呼び出しは1件1イベント、トークンは日次集計イベント。

## 動かし方

Docker と Node.js 24 以上、`openssl` が必要。npm 依存はない。

### 1. `lago/.env` を生成する(初回のみ)

`lago/.env` には API キーやパスワードが入るため、リポジトリには含めていない。
リポジトリのルートで次を実行すると、秘密の値をすべて乱数で生成して書き出す。

```bash
(umask 077 && cat > lago/.env <<EOF
# ローカルPoC専用。自動生成された値。コミットしないこと。
API_PORT=3100
FRONT_PORT=8088
POSTGRES_PORT=5442
REDIS_PORT=6389
LAGO_API_URL=http://localhost:3100
LAGO_FRONT_URL=http://localhost:8088
POSTGRES_PASSWORD=$(openssl rand -hex 16)
SECRET_KEY_BASE=$(openssl rand -hex 64)
LAGO_RSA_PRIVATE_KEY=$(openssl genrsa 2048 2>/dev/null | base64 | tr -d '\n')
LAGO_ENCRYPTION_PRIMARY_KEY=$(openssl rand -hex 16)
LAGO_ENCRYPTION_DETERMINISTIC_KEY=$(openssl rand -hex 16)
LAGO_ENCRYPTION_KEY_DERIVATION_SALT=$(openssl rand -hex 16)
LAGO_DISABLE_SEGMENT=true
LAGO_DISABLE_PDF_GENERATION=true
LAGO_DISABLE_SIGNUP=true
LAGO_CREATE_ORG=true
LAGO_ORG_NAME=billing-poc
LAGO_ORG_USER_EMAIL=poc@example.com
LAGO_ORG_USER_PASSWORD=$(openssl rand -hex 12)
LAGO_ORG_API_KEY=$(openssl rand -hex 24)
EOF
)
```

- ポートを変える場合は `API_PORT` と `LAGO_API_URL`、`FRONT_PORT` と `LAGO_FRONT_URL` をそろえて書き換える。
- 組織・ユーザー・API キーは、**データベースが空の状態での初回起動時にだけ**この値で作られる。
  起動後に `.env` を作り直すと、API キーや DB パスワードが既存データと食い違って接続できなくなる。
  作り直すときは先に `npm run lago:reset` でデータを消すこと。

### 2. 起動して実行する

```bash
npm run lago:up
```

```bash
npm test
```

```bash
npm run simulate
```

- ポートは既存サービスと衝突しないよう変えてある: API `3100`、画面 `8088`、Postgres `5442`、Redis `6389`。
- 画面は http://localhost:8088 。ログインは `poc@example.com`、パスワードは `lago/.env` の `LAGO_ORG_USER_PASSWORD`。
- PDF 生成は無効にしており、PDF 用コンテナは起動しない。
- `npm run simulate` は実行ごとに新しい顧客を9件作る。1回あたり5分前後(ほぼイベント集計の待ち時間)。
- `npm run probe` は下記所見の裏付けに使った追加検証。
### 比較画面(Lago なしで動く)

```bash
npm run web
```

http://localhost:4310 で開く。`lago/.env` も Lago の起動も不要で、外部には一切接続しない。

- **上段**: API呼び出し数と1件あたりのトークン数をスライダーで動かすと、3プランの支払総額・内訳・最安プランと、
  利用量に対する支払総額のグラフがその場で変わる。計算は [src/pricing.ts](src/pricing.ts) をそのまま使う。
- **下段**: `npm run simulate` が保存した [out/result.json](out/result.json)(Lago の実測結果と期待値の照合)を表示する。
  このファイルはリポジトリに含めてあるので、clone 直後でも表示できる。無い場合は案内文だけが出る。
- ポートは `PORT=5000 npm run web` のように変えられる。自分の PC からだけ見える(`127.0.0.1` で待ち受け)。

- 片付けは `npm run lago:down`、データごと消すなら `npm run lago:reset`。

### 即時に請求書を得る方法

Lago は請求日に時計ジョブが請求書を作る。待たずに1期間分の請求書を得るため、
契約開始日を「今日が期間最終日になる日」にさかのぼって設定し、イベント投入後に解約して最終請求書を発行させている
([src/usage.ts](src/usage.ts) の `billingPeriodClosingOn`)。最終日の解約なので基本料は満額になる。
前月に対応する日が無い日(例: 3/29〜3/30)は実行できずエラーにしている。

## Lago が吸収したもの(実測で確認)

| 複雑さ | 確認内容 |
|---|---|
| 生イベントからの集計 | 件数集計(count)と合計集計(sum)を、イベントを送るだけで実施 |
| 段階料金 | 3段にまたがる 6,001 件が ¥45,005 |
| 無料枠つきパッケージ料金 | 50万無料、10万単位の切り上げ |
| 小数単価の丸め | ¥4.5 × 2,001 件 = ¥9,004.5 を含む料金が四捨五入で ¥45,005 |
| 消費税 | 小計 ¥58,925 → 税 ¥5,893(¥5,892.5 を四捨五入) |
| 前払い残高の充当 | 税込合計に充当し、不足分だけ請求。残高も自動で減る |
| 日割り | 30日周期の11日目で解約すると基本料 ¥30,000 → ¥11,000 |
| 重複イベントの検出 | 同じ `transaction_id` は 422 で拒否 |
| 期中の利用量照会 | `current_usage` で請求前に利用量と金額を取得可能 |

## 呼び出し側に残るもの・注意点(実測で確認)

1. **購入クレジットは入金されるまで使えない。** ウォレット作成直後の残高はボーナス分の 2,000 だけ。
   購入分 20,000 は、購入請求書を入金済みにして初めて有効になる。決済連携が無い今回は API で入金済みにした。
2. **クレジット購入の請求書には税が付かない。** 税は消費時の請求書に付き、クレジットは税込額に充当される。
   つまり ¥20,000 のクレジットで使える税抜利用額は約 ¥18,182。税務・インボイス上の扱いは別途確認が要る。
3. **不正なイベントも API は 200 で受け付ける。** 存在しないメトリクスコードや契約開始前のタイムスタンプは、
   エラーにならず黙って請求対象外になる。検知には Webhook などの仕組みが別に必要(今回は未実装)。
4. **バッチ送信は1件でも重複があると全体が 422 で拒否される。** 残りも登録されない。
   そのため [src/events.ts](src/events.ts) で重複分を除いて再送している。
5. **イベント集計は非同期。** この環境(ノート PC の Docker、ワーカー1つ)では約 18,000 件の反映に3分弱かかった。
   性能測定ではないが、送信直後に請求を確定させる設計は避けたほうがよい。
6. **Lago は請求エンジンであり、シミュレーターではない。** 同じ利用データで3プランを比べるには、
   プランごとに顧客と契約を作って同じイベントを3回送る必要があった。

## 検証していないこと

決済サービス連携、前払い型の料金(利用時点で即請求)、プラン変更時の精算、クレジットの有効期限、最低利用料、
複数通貨、PDF 出力、有償版の機能、請求プレビュー API の有無と挙動。使用したのはセルフホスト版 v1.57.0。

## 構成

| ファイル | 役割 |
|---|---|
| [src/scenario.ts](src/scenario.ts) | プラン・顧客像・税・ウォレットの定義 |
| [src/usage.ts](src/usage.ts) | 請求期間の決定と利用データ生成 |
| [src/pricing.ts](src/pricing.ts) | 期待請求額の計算(Lago と独立した基準) |
| [src/lago-client.ts](src/lago-client.ts) | Lago REST API の呼び出し(リトライ・タイムアウト) |
| [src/lago-setup.ts](src/lago-setup.ts) | メトリクス・プラン・顧客・ウォレット・契約の作成 |
| [src/events.ts](src/events.ts) | イベント送信と重複時の再送 |
| [src/compare.ts](src/compare.ts) | 請求書の正規化と期待値との差分 |
| [src/main.ts](src/main.ts) | 通し実行 |
| [src/probe.ts](src/probe.ts) | 所見の裏付け用の追加検証 |
| [src/quote.ts](src/quote.ts) | 画面用の見積もり(3プラン比較・曲線・入力検証) |
| [src/server.ts](src/server.ts) / [src/serve.ts](src/serve.ts) | 比較画面用のローカルサーバーと起動 |
| [web/index.html](web/index.html) | 比較画面 |
