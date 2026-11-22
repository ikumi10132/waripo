import * as cdk from 'aws-cdk-lib';
import { WaripoStack } from '../lib/waripo-stack.js';

const app = new cdk.App();

// 2 人の割り勘。CloudShell からデプロイする (README 参照)
const stack = new WaripoStack(app, 'Waripo', {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? 'ap-southeast-2',
  },
  // 独自ドメインと証明書 (us-east-1 の ACM)。cdk.json の context に書く
  domainName: app.node.tryGetContext('domainName') || undefined,
  certificateArn: app.node.tryGetContext('certificateArn') || undefined,
});

// アプリごとの利用料を出すための目印 (ダッシュボード apps.wakalabo.net が集計する)
cdk.Tags.of(stack).add('app', 'waripo');
