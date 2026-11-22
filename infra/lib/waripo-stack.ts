import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as cdk from 'aws-cdk-lib';
import * as apigw from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as acm from 'aws-cdk-lib/aws-certificatemanager';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const LOCAL_DEV_URL = 'http://localhost:5173';
/** 家計簿から waripo の API を呼ぶので、家計簿のオリジンも許可する */
const KAKEIBO_ORIGINS = ['https://kakeibo.wakalabo.net'];

export interface WaripoStackProps extends cdk.StackProps {
  /** 独自ドメイン (waripo.wakalabo.net)。certificateArn (us-east-1 の ACM) とセットで指定 */
  domainName?: string;
  certificateArn?: string;
}

export class WaripoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: WaripoStackProps = {}) {
    super(scope, id, props);
    if (!!props.domainName !== !!props.certificateArn) throw new Error('domainName と certificateArn は両方指定してください');
    if (props.certificateArn && !props.certificateArn.startsWith('arn:aws:acm:us-east-1:')) {
      throw new Error('CloudFront で使う証明書は us-east-1 で作成したものを指定してください');
    }

    // ---------- W-SSO と家計簿 (それぞれのアプリが SSM に置いた値を読む) ----------
    const wssoPoolId = ssm.StringParameter.valueForStringParameter(this, '/wakalabo/auth/user-pool-id');
    const wssoClientId = ssm.StringParameter.valueForStringParameter(this, '/wakalabo/auth/wsso-client-id');
    const ssoUrl = ssm.StringParameter.valueForStringParameter(this, '/wakalabo/auth/sso-url');
    const kakeiboTableName = ssm.StringParameter.valueForStringParameter(this, '/wakalabo/kakeibo/table-name');
    const kakeiboTableArn = ssm.StringParameter.valueForStringParameter(this, '/wakalabo/kakeibo/table-arn');

    // ---------- データ ----------
    const table = new dynamodb.TableV2(this, 'Table', {
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billing: dynamodb.Billing.onDemand(),
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      deletionProtection: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---------- API ----------
    const fn = new nodejs.NodejsFunction(this, 'ApiFunction', {
      entry: path.join(root, 'api/src/handler.ts'),
      projectRoot: root,
      depsLockFilePath: path.join(root, 'package-lock.json'),
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: cdk.Duration.seconds(15),
      environment: {
        TABLE_NAME: table.tableName,
        KAKEIBO_TABLE: kakeiboTableName,
        USER_POOL_ID: wssoPoolId,
        NODE_OPTIONS: '--enable-source-maps',
      },
      bundling: { minify: true, sourceMap: true, externalModules: [] },
      logGroup: new logs.LogGroup(this, 'ApiLogs', { retention: logs.RetentionDays.ONE_MONTH, removalPolicy: cdk.RemovalPolicy.DESTROY }),
    });
    table.grantReadWriteData(fn);
    // 家計簿: 割り勘にした明細に印を付け、相手の家計簿に負担分を作る (明細とカテゴリーの読み書きだけ)
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem'],
        resources: [kakeiboTableArn],
      }),
    );
    // W-SSO: 相手をメールアドレスで探す (読み取りのみ)
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['cognito-idp:ListUsers'],
        resources: [`arn:aws:cognito-idp:${this.region}:${this.account}:userpool/${wssoPoolId}`],
      }),
    );

    const authorizer = new HttpJwtAuthorizer('WssoAuthorizer', `https://cognito-idp.${this.region}.amazonaws.com/${wssoPoolId}`, {
      jwtAudience: [wssoClientId],
    });

    // ---------- 画面 (S3 + CloudFront)。API も同じ CloudFront の /api に置く ----------
    const siteBucket = new s3.Bucket(this, 'SiteBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const api = new apigw.HttpApi(this, 'HttpApi', {
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: [...KAKEIBO_ORIGINS, LOCAL_DEV_URL, ...(props.domainName ? [`https://${props.domainName}`] : [])],
        allowMethods: [apigw.CorsHttpMethod.GET, apigw.CorsHttpMethod.POST, apigw.CorsHttpMethod.DELETE],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: cdk.Duration.hours(1),
      },
    });
    const integration = new HttpLambdaIntegration('ApiIntegration', fn);
    const { GET, POST, DELETE } = apigw.HttpMethod;
    api.addRoutes({ path: '/api/summary', methods: [GET], integration });
    api.addRoutes({ path: '/api/pair', methods: [POST], integration });
    api.addRoutes({ path: '/api/entries', methods: [POST], integration });
    api.addRoutes({ path: '/api/entries/{id}', methods: [DELETE], integration });
    const stage = api.defaultStage?.node.defaultChild as apigw.CfnStage;
    stage.defaultRouteSettings = { throttlingBurstLimit: 20, throttlingRateLimit: 10 };

    const apiDomain = cdk.Fn.select(2, cdk.Fn.split('/', api.apiEndpoint)); // https://xxx.execute-api... → xxx.execute-api...
    const distribution = new cloudfront.Distribution(this, 'Distribution', {
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(siteBucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.SECURITY_HEADERS,
      },
      additionalBehaviors: {
        '/api/*': {
          origin: new origins.HttpOrigin(apiDomain),
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.HTTPS_ONLY,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_ALL,
          cachePolicy: cloudfront.CachePolicy.CACHING_DISABLED,
          originRequestPolicy: cloudfront.OriginRequestPolicy.ALL_VIEWER_EXCEPT_HOST_HEADER,
        },
      },
      defaultRootObject: 'index.html',
      errorResponses: [403, 404].map((httpStatus) => ({ httpStatus, responseHttpStatus: 200, responsePagePath: '/index.html' })),
      priceClass: cloudfront.PriceClass.PRICE_CLASS_200,
      ...(props.domainName &&
        props.certificateArn && {
          domainNames: [props.domainName],
          certificate: acm.Certificate.fromCertificateArn(this, 'Certificate', props.certificateArn),
        }),
    });
    const siteUrl = props.domainName ? `https://${props.domainName}` : `https://${distribution.distributionDomainName}`;

    new s3deploy.BucketDeployment(this, 'DeployWeb', {
      sources: [
        s3deploy.Source.asset(path.join(root, 'web/dist')),
        s3deploy.Source.jsonData('config.json', { apiUrl: '/api', ssoUrl, wssoClientId, region: this.region }),
      ],
      destinationBucket: siteBucket,
      distribution,
      distributionPaths: ['/*'],
    });

    new cdk.CfnOutput(this, 'SiteUrl', { value: siteUrl });
    new cdk.CfnOutput(this, 'CloudFrontDomain', { value: distribution.distributionDomainName });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
  }
}
