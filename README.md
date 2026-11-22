# waripo

2 人の割り勘と貸し借りを記録して、「いまどちらがいくら借りているか」を出す Web アプリです。
家計簿 (kakeibo) と連動していて、家計簿の明細から割り勘にすると、相手の家計簿にも相手の負担分が入ります。

```
[スマホ/PC の画面] ── CloudFront ─┬─ S3 (画面)
                                 └─ /api/* ─▶ API Gateway ─▶ Lambda ─┬─▶ DynamoDB (waripo)
[家計簿の画面] ──(W-SSO のトークン)─┘                                  └─▶ DynamoDB (kakeibo)
```

| ディレクトリ | 内容 |
|---|---|
| `api/` | Lambda (TypeScript)。ペア・割り勘・精算・最初の残高 |
| `web/` | 画面 (React + Vite) |
| `infra/` | AWS CDK。S3 / CloudFront / API Gateway / Lambda / DynamoDB |

## できること

- 割り勘の記録 (どちらが払ったか、半分ずつ / 金額を指定)
- 精算 (お金を渡した・受け取った) と、最初の残高 (Warica などからの引き継ぎ)
- いまの貸し借りの残高
- **家計簿と連動**: 家計簿の明細の「waripo で割り勘」から割り勘にすると、
  - 自分の明細は「自分の負担」だけが支出として数えられる
  - 相手の家計簿に相手の負担分が「waripoから自動登録」として入る
  - カテゴリーも同じものが付く (相手の家計簿に同じ名前のカテゴリーがなければ、親カテゴリーごと作る)。
    付けるのは割り勘にした時点のコピーだけで、あとでどちらかがカテゴリーを変えても相手には反映しない
  - waripo で割り勘を消すと、家計簿も元に戻る

## デプロイ (CloudShell)

先に **wakalabo-apps** (W-SSO) と **kakeibo** をデプロイしておいてください (waripo はその 2 つが SSM パラメータに置いた値を読みます)。

1. AWS コンソール右上の `>_` アイコンで CloudShell を開く (リージョンは ap-southeast-2)
2. 次をまとめて貼り付けて Enter

```bash
curl -so- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.3/install.sh | bash >/dev/null && source ~/.nvm/nvm.sh && nvm install 22 >/dev/null \
  && cd /tmp && rm -rf waripo && git clone --depth 1 https://github.com/ikumi10132/waripo.git && cd waripo \
  && npm ci && npm run build && cd infra && npx cdk deploy Waripo --require-approval never
```

- 最後に `Waripo.CloudFrontDomain` が表示されます
- 初回だけ、お名前.com の DNS に CNAME を追加します: ホスト名 `waripo` → `Waripo.CloudFrontDomain` の値
- 独自ドメインと証明書 (us-east-1) は `infra/cdk.json` の context に書いてあります
- コードを更新したときも、同じコマンドを貼り付けるだけです

## 使い始め

1. ダッシュボードの「ユーザー管理」で、2 人とも waripo を使えるようにする (グループ `app-waripo`)
2. waripo を開いて W-SSO でログインし、相手のメールアドレスを登録してペアを作る
3. 「設定」→「最初の残高」で、いままでの貸し借りの残高を入れる
4. 以後は、家計簿の明細を開いて「waripo で割り勘」、または waripo の「割り勘を追加」から記録する

## 開発

```bash
npm ci
npm run typecheck
npm test
```
