// DynamoDB (waripo と kakeibo の 2 つのテーブル) と Cognito をメモリ上の簡易版に差し替えて、API を通しで動かす
import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { ConditionalCheckFailedException } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
process.env.TABLE_NAME = 'waripo';
process.env.KAKEIBO_TABLE = 'kakeibo';
const { handler } = await import('../src/handler.js');
const { balanceFor, halfShare } = await import('../src/logic.js');
import type { Entry, Summary } from '../src/types.js';

type Item = Record<string, unknown> & { PK: string; SK: string };
const tables = new Map<string, Map<string, Item>>();
const tbl = (name: string) => {
  if (!tables.has(name)) tables.set(name, new Map());
  return tables.get(name)!;
};
const key = (k: { PK: unknown; SK: unknown }) => `${k.PK}|${k.SK}`;

const USERS = [
  { sub: 'me', email: 'alice@example.com' },
  { sub: 'pt', email: 'partner@example.com' },
  { sub: 'x3', email: 'third@example.com' },
];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(CognitoIdentityProviderClient.prototype as any).send = async (cmd: { input: { Filter: string } }) => {
  const [, field, value] = cmd.input.Filter.match(/^(\w+) = "(.*)"$/)!;
  const u = USERS.find((x) => (field === 'email' ? x.email === value : x.sub === value));
  return { Users: u ? [{ Attributes: [{ Name: 'sub', Value: u.sub }, { Name: 'email', Value: u.email }] }] : [] };
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(DynamoDBDocumentClient.prototype as any).send = async function (cmd: { constructor: { name: string }; input: any }) {
  const i = cmd.input;
  const t = i.TableName ? tbl(i.TableName) : undefined;
  switch (cmd.constructor.name) {
    case 'GetCommand':
      return { Item: structuredClone(t!.get(key(i.Key))) };
    case 'PutCommand':
      t!.set(key(i.Item), structuredClone(i.Item));
      return {};
    case 'DeleteCommand':
      t!.delete(key(i.Key));
      return {};
    case 'UpdateCommand': {
      const it = t!.get(key(i.Key));
      if (!it) throw new ConditionalCheckFailedException({ message: 'x', $metadata: {} });
      if (i.UpdateExpression.startsWith('SET')) it.split = i.ExpressionAttributeValues[':s'];
      else delete it.split;
      return {};
    }
    case 'QueryCommand': {
      const pk = i.ExpressionAttributeValues[':pk'];
      const sk = i.ExpressionAttributeValues[':sk'];
      return { Items: [...t!.values()].filter((x) => x.PK === pk && x.SK.startsWith(sk)).map((x) => structuredClone(x)) };
    }
    case 'TransactWriteCommand': {
      for (const ti of i.TransactItems) {
        const p = ti.Put;
        if (p.ConditionExpression && tbl(p.TableName).has(key(p.Item))) {
          throw Object.assign(new Error('cancel'), { name: 'TransactionCanceledException' });
        }
      }
      for (const ti of i.TransactItems) tbl(ti.Put.TableName).set(key(ti.Put.Item), structuredClone(ti.Put.Item));
      return {};
    }
    default:
      throw new Error(`未対応: ${cmd.constructor.name}`);
  }
};

async function call<T>(routeKey: string, opts: { body?: unknown; id?: string; as?: string; groups?: string } = {}) {
  const res = (await handler({
    routeKey,
    headers: {},
    isBase64Encoded: false,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    pathParameters: opts.id ? { id: opts.id } : undefined,
    requestContext: { authorizer: { jwt: { claims: { sub: opts.as ?? 'me', 'cognito:groups': opts.groups ?? '[app-waripo]' } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer)) as APIGatewayProxyStructuredResultV2;
  return { status: res.statusCode!, body: JSON.parse(res.body as string) as T };
}

const kakeibo = () => tbl('kakeibo');
const pair = () => call('POST /api/pair', { body: { partnerEmail: 'Partner@Example.com' } });

beforeEach(() => tables.clear());

test('半分ずつの端数は払った人が持ち、残高は貸し借りの流れの合計', () => {
  assert.equal(halfShare(1001), 500);
  const e = (from: string, to: string, type: Entry['type'], amount: number, share?: number) =>
    ({ from, to, type, amount, share }) as Entry;
  // 自分が 6000 円払って相手の負担 3000 → +3000、相手から 1000 返してもらう → +2000、相手が 2000 払って自分の負担 1000 → +1000
  assert.equal(balanceFor('me', [e('me', 'pt', 'split', 6000, 3000), e('pt', 'me', 'settle', 1000), e('pt', 'me', 'split', 2000, 1000)]), 1000);
  // 最初の残高: 自分が相手に 500 借りている
  assert.equal(balanceFor('me', [e('pt', 'me', 'initial', 500)]), -500);
});

test('権限とペアの登録', async () => {
  assert.equal((await call('GET /api/summary', { groups: '[app-kakeibo]' })).status, 403);
  assert.equal((await call('GET /api/summary', { groups: '[admin]' })).status, 200);
  assert.equal((await call('POST /api/entries', { body: { type: 'settle', amount: 1, direction: 'toMe' } })).status, 400); // ペアがまだない
  assert.equal((await call('POST /api/pair', { body: { partnerEmail: 'nobody@example.com' } })).status, 404);
  assert.equal((await call('POST /api/pair', { body: { partnerEmail: 'alice@example.com' } })).status, 400);
  assert.equal((await pair()).status, 201);
  assert.equal((await call('POST /api/pair', { as: 'x3', body: { partnerEmail: 'partner@example.com' } })).status, 400); // 相手は別のペア
  const s = await call<Summary>('GET /api/summary', { as: 'pt' });
  assert.equal(s.body.partner?.email, 'alice@example.com'); // 相手からも自分が見える
});

test('家計簿の明細から割り勘: 自分の明細に印、相手の家計簿に負担分 (未確認・メモ付き)、削除で元に戻る', async () => {
  await pair();
  kakeibo().set('USER#me|TX#2026-11-14#abc', {
    PK: 'USER#me', SK: 'TX#2026-11-14#abc', id: '2026-11-14_abc', date: '2026-11-14', type: 'expense', amount: 6001,
    categoryId: 'food-eatout', merchant: '居酒屋', memo: '', source: 'manual', confirmed: true, payment: 'applepay', createdAt: '',
  });
  kakeibo().set('USER#pt|CAT#food-eatout', { PK: 'USER#pt', SK: 'CAT#food-eatout' });

  const r = await call<Entry>('POST /api/entries', { body: { type: 'split', kakeiboTxId: '2026-11-14_abc' } });
  assert.equal(r.status, 201);
  assert.equal(r.body.amount, 6001);
  assert.equal(r.body.share, 3000);
  const mine = kakeibo().get('USER#me|TX#2026-11-14#abc')!;
  assert.deepEqual(mine.split, { entryId: r.body.id, role: 'payer', otherShare: 3000 });
  const theirs = [...kakeibo().values()].find((x) => x.PK === 'USER#pt' && x.SK.startsWith('TX#'))!;
  assert.equal(theirs.amount, 3000);
  assert.equal(theirs.memo, 'waripoから自動登録');
  assert.equal(theirs.confirmed, false);
  assert.equal(theirs.categoryId, 'food-eatout'); // 相手も同じカテゴリーを持っていた

  assert.equal((await call<Summary>('GET /api/summary')).body.balance, 3000);
  assert.equal((await call<Summary>('GET /api/summary', { as: 'pt' })).body.balance, -3000);
  // 同じ明細は 2 回割り勘にできない
  assert.equal((await call('POST /api/entries', { body: { type: 'split', kakeiboTxId: '2026-11-14_abc' } })).status, 400);

  // 相手が削除しても、2 人の家計簿が元に戻る
  assert.equal((await call('DELETE /api/entries/{id}', { as: 'pt', id: r.body.id })).status, 200);
  assert.equal(kakeibo().get('USER#me|TX#2026-11-14#abc')!.split, undefined);
  assert.equal([...kakeibo().values()].filter((x) => x.PK === 'USER#pt' && x.SK.startsWith('TX#')).length, 0);
  assert.equal((await call<Summary>('GET /api/summary')).body.balance, 0);
});

test('waripo で直接入力: 相手が払った割り勘、精算、最初の残高', async () => {
  await pair();
  const s = await call<Entry>('POST /api/entries', { body: { type: 'split', payer: 'partner', amount: '¥4,000', title: 'スーパー', date: '2026-11-20' } });
  assert.equal(s.status, 201);
  assert.equal(s.body.from, 'pt');
  // 2 人の家計簿に記録される (払った相手は全額、自分は負担分)
  const txs = [...kakeibo().values()].filter((x) => x.SK.startsWith('TX#'));
  assert.deepEqual(txs.map((x) => [x.PK, x.amount]).sort(), [['USER#me', 2000], ['USER#pt', 4000]]);

  await call('POST /api/entries', { body: { type: 'initial', amount: 1500, direction: 'partnerOwesMe' } }); // Warica から: 相手が 1500 借りている
  await call('POST /api/entries', { body: { type: 'settle', amount: 500, direction: 'toMe' } }); // 相手から 500 受け取った
  const sum = await call<Summary>('GET /api/summary');
  assert.equal(sum.body.balance, -2000 + 1500 - 500); // -1000: 自分が相手に 1000 借りている
  assert.equal(sum.body.entries.length, 3);

  // 家計簿に記録しない割り勘
  await call('POST /api/entries', { body: { type: 'split', amount: 100, syncKakeibo: false } });
  assert.equal([...kakeibo().values()].filter((x) => x.SK.startsWith('TX#')).length, 2);
  // 削除すると、waripo が作った明細は両方消える
  await call('DELETE /api/entries/{id}', { id: s.body.id });
  assert.equal([...kakeibo().values()].filter((x) => x.SK.startsWith('TX#')).length, 0);
});

test('入力のチェック', async () => {
  await pair();
  assert.equal((await call('POST /api/entries', { body: { type: 'split', amount: 0 } })).status, 400);
  assert.equal((await call('POST /api/entries', { body: { type: 'split', amount: 100, share: 200 } })).status, 400);
  assert.equal((await call('POST /api/entries', { body: { type: 'settle', amount: 100, direction: 'x' } })).status, 400);
  assert.equal((await call('POST /api/entries', { body: { type: 'split', kakeiboTxId: '2026-01-01_none' } })).status, 404);
  assert.equal((await call('DELETE /api/entries/{id}', { id: '2026-01-01_none' })).status, 404);
});
