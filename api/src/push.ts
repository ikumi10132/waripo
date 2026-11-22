/**
 * iPhone などへの通知 (Web プッシュ)。
 * 端末の登録 (購読) と通知の設定は家計簿のテーブルに置き、家計簿と waripo の両方から送る。
 * このファイルは kakeibo の api/src/push.ts のコピー。waripo では送るだけ (鍵は家計簿の API が作る)。
 *
 * 家計簿のテーブルのキー:
 *   SYSTEM           VAPID          通知を送るための鍵 (最初に家計簿の API が自動で作る)
 *   USER#<sub>       NOTIFY         通知の設定 (種類ごとのオン/オフ)
 *   USER#<sub>       PUSH#<hash>    通知を受け取る端末 (ブラウザが発行した購読情報)
 */
import { createHash } from 'node:crypto';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import webpush from 'web-push';

export type NotifyKind = 'mail' | 'waripo';
export interface NotifySettings {
  /** 利用通知メールから自動で記録したとき */
  mail: boolean;
  /** 相手が waripo で割り勘にして、自分の家計簿に入ったとき */
  waripo: boolean;
}
export const DEFAULT_SETTINGS: NotifySettings = { mail: true, waripo: true };

export interface PushSubscriptionJson {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface PushMessage {
  title: string;
  body: string;
  /** 通知を押したときに開く画面 (例: /?tab=inbox) */
  url?: string;
  /** 同じ tag の通知は上書きされる */
  tag?: string;
}

/** 通知の送り主として Apple / Google に伝える連絡先 (メールアドレスは使わない) */
const SUBJECT = 'https://kakeibo.wakalabo.net';
const VAPID_KEY = { PK: 'SYSTEM', SK: 'VAPID' };

type Sender = (sub: PushSubscriptionJson, payload: string, options: webpush.RequestOptions) => Promise<{ statusCode: number }>;
let sender: Sender = (sub, payload, options) => webpush.sendNotification(sub, payload, options);
/** テスト用: 実際には送らずに受け取る */
export const setSender = (s: Sender) => {
  sender = s;
};

const doc = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
const subKey = (endpoint: string) => `PUSH#${createHash('sha256').update(endpoint).digest('hex').slice(0, 32)}`;

/** 購読情報として正しい形か (ブラウザから届いた値を確かめる) */
export function isSubscription(v: unknown): v is PushSubscriptionJson {
  const s = v as PushSubscriptionJson;
  return (
    !!s &&
    typeof s.endpoint === 'string' &&
    /^https:\/\/[^\s]{1,2000}$/.test(s.endpoint) &&
    typeof s.keys?.p256dh === 'string' &&
    typeof s.keys?.auth === 'string' &&
    s.keys.p256dh.length < 200 &&
    s.keys.auth.length < 100
  );
}

export function pushStore(table: string) {
  /** 通知を送るための鍵。create: なければ作る (家計簿の API だけが作る) */
  async function vapid(create: boolean): Promise<{ publicKey: string; privateKey: string } | undefined> {
    const got = await doc.send(new GetCommand({ TableName: table, Key: VAPID_KEY }));
    if (got.Item) return { publicKey: got.Item.publicKey as string, privateKey: got.Item.privateKey as string };
    if (!create) return undefined;
    const keys = webpush.generateVAPIDKeys();
    try {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: { ...VAPID_KEY, ...keys, createdAt: new Date().toISOString() },
          ConditionExpression: 'attribute_not_exists(PK)', // 同時に作られたら、先に作られた方を使う
        }),
      );
      return keys;
    } catch (e) {
      if ((e as Error).name !== 'ConditionalCheckFailedException') throw e;
      return vapid(false);
    }
  }

  async function settings(uid: string): Promise<NotifySettings> {
    const got = await doc.send(new GetCommand({ TableName: table, Key: { PK: `USER#${uid}`, SK: 'NOTIFY' } }));
    return { ...DEFAULT_SETTINGS, ...((got.Item?.settings as Partial<NotifySettings>) ?? {}) };
  }

  async function subscriptions(uid: string): Promise<(PushSubscriptionJson & { SK: string })[]> {
    const res = await doc.send(
      new QueryCommand({
        TableName: table,
        KeyConditionExpression: 'PK = :pk AND begins_with(SK, :sk)',
        ExpressionAttributeValues: { ':pk': `USER#${uid}`, ':sk': 'PUSH#' },
      }),
    );
    return (res.Items ?? []) as (PushSubscriptionJson & { SK: string })[];
  }

  return {
    publicKey: async () => (await vapid(true))!.publicKey,
    settings,
    async saveSettings(uid: string, s: NotifySettings): Promise<NotifySettings> {
      const next: NotifySettings = { mail: !!s.mail, waripo: !!s.waripo };
      await doc.send(new PutCommand({ TableName: table, Item: { PK: `USER#${uid}`, SK: 'NOTIFY', settings: next } }));
      return next;
    },
    async subscribe(uid: string, sub: PushSubscriptionJson, device: string): Promise<void> {
      await doc.send(
        new PutCommand({
          TableName: table,
          Item: { PK: `USER#${uid}`, SK: subKey(sub.endpoint), endpoint: sub.endpoint, keys: sub.keys, device: device.slice(0, 200), createdAt: new Date().toISOString() },
        }),
      );
    },
    async unsubscribe(uid: string, endpoint: string): Promise<void> {
      await doc.send(new DeleteCommand({ TableName: table, Key: { PK: `USER#${uid}`, SK: subKey(endpoint) } }));
    },
    deviceCount: async (uid: string) => (await subscriptions(uid)).length,

    /**
     * その人の登録済みの端末すべてに通知する。kind が null のときは設定に関係なく送る (テスト通知)。
     * 通知の失敗で記録の処理を失敗させないよう、エラーは投げずにログに残すだけ。送れた端末の数を返す
     */
    async notify(uid: string, kind: NotifyKind | null, msg: PushMessage): Promise<number> {
      try {
        if (kind && !(await settings(uid))[kind]) return 0;
        const subs = await subscriptions(uid);
        if (subs.length === 0) return 0;
        const keys = await vapid(false);
        if (!keys) return 0;
        const payload = JSON.stringify(msg);
        const results = await Promise.all(
          subs.map(async (s) => {
            try {
              await sender({ endpoint: s.endpoint, keys: s.keys }, payload, {
                vapidDetails: { subject: SUBJECT, publicKey: keys.publicKey, privateKey: keys.privateKey },
                TTL: 24 * 60 * 60, // 端末がオフラインでも 1 日は届ける
                timeout: 5000,
              });
              return 1;
            } catch (e) {
              const status = (e as { statusCode?: number }).statusCode;
              // 404 / 410: 端末側で通知をやめた・アプリを消した。登録を消す
              if (status === 404 || status === 410) {
                await doc.send(new DeleteCommand({ TableName: table, Key: { PK: `USER#${uid}`, SK: s.SK } }));
              } else {
                console.warn('push: failed', status, (e as Error).message);
              }
              return 0;
            }
          }),
        );
        return results.reduce<number>((a, b) => a + b, 0);
      } catch (e) {
        console.warn('push: error', (e as Error).message);
        return 0;
      }
    },
  };
}
