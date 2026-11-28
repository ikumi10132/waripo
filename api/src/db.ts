// データの読み書き
//
// waripo のテーブル:
//   PK              SK                      内容
//   USER#<sub>      PAIR                    その人が入っているペアの id
//   PAIR#<id>       META                    ペア (2 人) の情報
//   PAIR#<id>       ENTRY#<日付>#<id>        割り勘・精算・最初の残高の記録
//
// 家計簿 (kakeibo) のテーブル: 割り勘にした明細に印を付け、相手の家計簿に負担分の明細を作る
//   USER#<sub>      TX#<日付>#<id>          明細 (kakeibo の形のまま)
import { randomUUID } from 'node:crypto';
import { AdminListGroupsForUserCommand, CognitoIdentityProviderClient, ListUsersCommand } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import type { Entry, KakeiboSplit, Member, Pair } from './types.js';

const TABLE = process.env.TABLE_NAME ?? 'waripo';
const KAKEIBO_TABLE = process.env.KAKEIBO_TABLE ?? 'kakeibo';
const USER_POOL_ID = process.env.USER_POOL_ID ?? '';

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const cognito = new CognitoIdentityProviderClient({});

export const shortId = () => randomUUID().replace(/-/g, '').slice(0, 12);
const strip = <T>(item: Record<string, unknown>): T => {
  const { PK: _pk, SK: _sk, ...rest } = item;
  return rest as T;
};

// ---------- W-SSO のユーザー ----------

async function findUser(filter: string): Promise<Member | undefined> {
  const res = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Filter: filter, Limit: 1 }));
  const u = res.Users?.[0];
  const attr = (n: string) => u?.Attributes?.find((a) => a.Name === n)?.Value;
  const sub = attr('sub');
  const email = attr('email');
  return sub && email ? { sub, email } : undefined;
}

const quote = (s: string) => `"${s.replace(/["\\]/g, '')}"`;
export const userByEmail = (email: string) => findUser(`email = ${quote(email.toLowerCase())}`);
export const userBySub = (sub: string) => findUser(`sub = ${quote(sub)}`);

/** waripo を使える人か (止められておらず、admin か app-waripo のグループに入っている) */
export async function canUseWaripo(sub: string): Promise<boolean> {
  const res = await cognito.send(new ListUsersCommand({ UserPoolId: USER_POOL_ID, Filter: `sub = ${quote(sub)}`, Limit: 1 }));
  const u = res.Users?.[0];
  if (!u?.Username || u.Enabled === false) return false;
  const groups = await cognito.send(new AdminListGroupsForUserCommand({ UserPoolId: USER_POOL_ID, Username: u.Username, Limit: 60 }));
  const names = (groups.Groups ?? []).map((g) => g.GroupName);
  return names.includes('admin') || names.includes('app-waripo');
}

// ---------- ペア ----------

export async function pairOf(sub: string): Promise<Pair | null> {
  const link = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: `USER#${sub}`, SK: 'PAIR' } }));
  const pairId = link.Item?.pairId as string | undefined;
  if (!pairId) return null;
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: `PAIR#${pairId}`, SK: 'META' } }));
  return res.Item ? strip<Pair>(res.Item) : null;
}

/** ペアを申し込む (a が b に)。b が承認するまでは記録できない。どちらかがすでにペア (申し込み中を含む) に入っていたら失敗する */
export async function createPair(a: Member, b: Member): Promise<Pair> {
  const pair: Pair = { id: shortId(), members: [a, b], createdAt: new Date().toISOString(), status: 'pending', requestedBy: a.sub };
  await doc.send(
    new TransactWriteCommand({
      TransactItems: [
        { Put: { TableName: TABLE, Item: { PK: `PAIR#${pair.id}`, SK: 'META', ...pair } } },
        ...[a, b].map((m) => ({
          Put: {
            TableName: TABLE,
            Item: { PK: `USER#${m.sub}`, SK: 'PAIR', pairId: pair.id },
            ConditionExpression: 'attribute_not_exists(PK)',
          },
        })),
      ],
    }),
  );
  return pair;
}

/** 申し込みを承認してペアを成立させる */
export async function activatePair(pairId: string): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: `PAIR#${pairId}`, SK: 'META' },
      UpdateExpression: 'SET #s = :active REMOVE requestedBy',
      ConditionExpression: '#s = :pending',
      ExpressionAttributeNames: { '#s': 'status' },
      ExpressionAttributeValues: { ':active': 'active', ':pending': 'pending' },
    }),
  );
}

/** 申し込みを取り消す・断る (成立したペアは消さない) */
export async function deletePendingPair(pair: Pair): Promise<void> {
  await doc.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Delete: {
            TableName: TABLE,
            Key: { PK: `PAIR#${pair.id}`, SK: 'META' },
            ConditionExpression: '#s = :pending',
            ExpressionAttributeNames: { '#s': 'status' },
            ExpressionAttributeValues: { ':pending': 'pending' },
          },
        },
        ...pair.members.map((m) => ({ Delete: { TableName: TABLE, Key: { PK: `USER#${m.sub}`, SK: 'PAIR' } } })),
      ],
    }),
  );
}

// ---------- 記録 ----------

const entrySk = (id: string) => {
  const [date, rand] = id.split('_');
  if (!date || !rand) throw new Error('記録の id が不正です');
  return `ENTRY#${date}#${rand}`;
};

export async function listEntries(pairId: string): Promise<Entry[]> {
  const items: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `PAIR#${pairId}`, ':sk': 'ENTRY#' },
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  return items.map((i) => strip<Entry>(i)).sort((a, b) => (a.id < b.id ? 1 : -1));
}

export async function getEntry(pairId: string, id: string): Promise<Entry | undefined> {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: { PK: `PAIR#${pairId}`, SK: entrySk(id) } }));
  return res.Item ? strip<Entry>(res.Item) : undefined;
}

export async function putEntry(pairId: string, e: Entry): Promise<void> {
  await doc.send(new PutCommand({ TableName: TABLE, Item: { PK: `PAIR#${pairId}`, SK: entrySk(e.id), ...e } }));
}

export async function deleteEntry(pairId: string, id: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: TABLE, Key: { PK: `PAIR#${pairId}`, SK: entrySk(id) } }));
}

// ---------- 家計簿 (kakeibo のテーブル) ----------

export interface KakeiboTx {
  id: string;
  date: string;
  type: 'expense' | 'income';
  amount: number;
  categoryId: string | null;
  payment: string;
  merchant: string;
  memo: string;
  source: string;
  confirmed: boolean;
  advance?: boolean;
  received?: number | null;
  split?: KakeiboSplit;
  /** 分割払いの回 (割り勘にはできない) */
  installment?: { planId: string; index: number; count: number };
  createdAt: string;
}

const txKey = (sub: string, id: string) => {
  const [date, rand] = id.split('_');
  if (!date || !rand) throw new Error('家計簿の明細の id が不正です');
  return { PK: `USER#${sub}`, SK: `TX#${date}#${rand}` };
};

export async function getKakeiboTx(sub: string, id: string): Promise<KakeiboTx | undefined> {
  const res = await doc.send(new GetCommand({ TableName: KAKEIBO_TABLE, Key: txKey(sub, id) }));
  return res.Item ? strip<KakeiboTx>(res.Item) : undefined;
}

/** 家計簿のカテゴリー (kakeibo の Category と同じ形) */
export interface KakeiboCategory {
  id: string;
  name: string;
  type: 'expense' | 'income';
  parentId: string | null;
  icon: string;
  color: string;
  order: number;
}

export async function getKakeiboCategory(sub: string, id: string): Promise<KakeiboCategory | undefined> {
  const res = await doc.send(new GetCommand({ TableName: KAKEIBO_TABLE, Key: { PK: `USER#${sub}`, SK: `CAT#${id}` } }));
  return res.Item ? strip<KakeiboCategory>(res.Item) : undefined;
}

export async function listKakeiboCategories(sub: string): Promise<KakeiboCategory[]> {
  const items: Record<string, unknown>[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const res = await doc.send(
      new QueryCommand({
        TableName: KAKEIBO_TABLE,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `USER#${sub}`, ':sk': 'CAT#' },
        ExclusiveStartKey: start,
      }),
    );
    items.push(...(res.Items ?? []));
    start = res.LastEvaluatedKey;
  } while (start);
  return items.map((i) => strip<KakeiboCategory>(i));
}

/** 相手の家計簿にカテゴリーを作る (同じ id がすでにあれば上書きしない) */
export async function putKakeiboCategory(sub: string, c: KakeiboCategory): Promise<void> {
  await doc
    .send(
      new PutCommand({
        TableName: KAKEIBO_TABLE,
        Item: { PK: `USER#${sub}`, SK: `CAT#${c.id}`, ...c },
        ConditionExpression: 'attribute_not_exists(PK)',
      }),
    )
    .catch((e: Error) => {
      if (e.name !== 'ConditionalCheckFailedException') throw e;
    });
}

/** waripo から家計簿に明細を作る (メモ「waripoから自動登録」) */
export async function createKakeiboTx(
  sub: string,
  t: Pick<KakeiboTx, 'date' | 'amount' | 'categoryId' | 'merchant' | 'split'>,
): Promise<string> {
  const id = `${t.date}_${shortId()}`;
  const tx: KakeiboTx = {
    id,
    date: t.date,
    type: 'expense',
    amount: t.amount,
    categoryId: t.categoryId,
    payment: 'other',
    merchant: t.merchant,
    memo: 'waripoから自動登録',
    source: 'waripo',
    // カテゴリーが決まっていれば確認済み (家計簿の店名ルールで決まったときと同じ扱い)。決まらなければ「未確認」に入る
    confirmed: t.categoryId !== null,
    split: t.split,
    createdAt: new Date().toISOString(),
  };
  await doc.send(new PutCommand({ TableName: KAKEIBO_TABLE, Item: { ...txKey(sub, id), ...tx } }));
  return id;
}

/** 家計簿の明細に割り勘の印を付ける (null で外す)。明細がなければ何もしない */
export async function setKakeiboSplit(sub: string, id: string, split: KakeiboSplit | null): Promise<void> {
  await doc
    .send(
      new UpdateCommand({
        TableName: KAKEIBO_TABLE,
        Key: txKey(sub, id),
        ConditionExpression: 'attribute_exists(PK)',
        ...(split
          ? { UpdateExpression: 'SET #s = :s', ExpressionAttributeNames: { '#s': 'split' }, ExpressionAttributeValues: { ':s': split } }
          : { UpdateExpression: 'REMOVE #s', ExpressionAttributeNames: { '#s': 'split' } }),
      }),
    )
    .catch((e: Error) => {
      if (e.name !== 'ConditionalCheckFailedException') throw e; // 明細が消されていた・日付が変わっていた
    });
}

export async function deleteKakeiboTx(sub: string, id: string): Promise<void> {
  await doc.send(new DeleteCommand({ TableName: KAKEIBO_TABLE, Key: txKey(sub, id) }));
}
