import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import * as db from './db.js';
import { partnerCategoryId } from './kakeibo-category.js';
import { pushStore } from './push.js';
import { balanceFor, groupsFromClaim, halfShare, isDate, parseYen, todayJst, yen } from './logic.js';
import type { Entry, Member, Pair, Summary } from './types.js';

/** W-SSO のグループ。このグループの人 (と管理者) だけが waripo を使える */
const APP_GROUP = 'app-waripo';
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  body: JSON.stringify(body),
});

function parseBody(event: APIGatewayProxyEventV2WithJWTAuthorizer): Record<string, unknown> {
  if (!event.body) return {};
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    /* 下でエラーにする */
  }
  throw new HttpError(400, '本文は JSON オブジェクトで送ってください');
}

const str = (v: unknown, max = 100) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const yenOf = (v: unknown, allowZero = false) => {
  try {
    return parseYen(v, allowZero);
  } catch (e) {
    throw new HttpError(400, (e as Error).message);
  }
};

interface Ctx {
  me: string;
  pair: Pair;
  partner: Member;
}

// 通知 (Web プッシュ)。端末の登録と通知の設定は家計簿のテーブルにある
const push = pushStore(process.env.KAKEIBO_TABLE ?? 'kakeibo');
const KAKEIBO_URL = 'https://kakeibo.wakalabo.net/';
const nameOf = (m?: Member) => (m ? m.email.split('@')[0]! : '相手');

/** 相手の家計簿に割り勘の明細を入れたことを、相手の iPhone に知らせる (相手が設定でオフにしていれば送らない) */
async function notifyPartner(c: Ctx, entry: Entry): Promise<void> {
  const me = nameOf(c.pair.members.find((m) => m.sub === c.me));
  const partnerPaid = entry.from === c.partner.sub;
  const body = partnerPaid
    ? `${me} が「${entry.title}」(${yen(entry.amount)}) を割り勘にしました。${me} の負担は ${yen(entry.share ?? 0)} です`
    : `${me} が「${entry.title}」を割り勘にしました。あなたの負担 ${yen(entry.share ?? 0)} を家計簿に記録しました`;
  await push.notify(c.partner.sub, 'waripo', { title: 'waripo', body, url: KAKEIBO_URL, tag: entry.id });
}

async function requirePair(me: string): Promise<Ctx> {
  const pair = await db.pairOf(me);
  if (!pair) throw new HttpError(400, '先に割り勘の相手を登録してください');
  const partner = pair.members.find((m) => m.sub !== me);
  if (!partner) throw new HttpError(500, 'ペアの情報が壊れています');
  return { me, pair, partner };
}

const newEntryId = (date: string) => `${date}_${db.shortId()}`;

/** 割り勘を記録する。家計簿の明細からのときは、その明細に印を付けて、相手の家計簿に負担分を作る */
async function createSplit(c: Ctx, b: Record<string, unknown>): Promise<Entry> {
  const kakeiboTxId = str(b.kakeiboTxId, 60);
  const now = new Date().toISOString();

  if (kakeiboTxId) {
    // 家計簿の明細から: 払ったのは自分
    const tx = await db.getKakeiboTx(c.me, kakeiboTxId);
    if (!tx) throw new HttpError(404, '家計簿の明細が見つかりません');
    if (tx.type !== 'expense') throw new HttpError(400, '支出の明細だけ割り勘にできます');
    if (tx.split) throw new HttpError(400, 'この明細はすでに割り勘にしています');
    if (tx.advance) throw new HttpError(400, '立て替えの明細は割り勘にできません。立て替えをオフにしてから割り勘にしてください');
    const share = b.share === undefined || b.share === '' ? halfShare(tx.amount) : yenOf(b.share, true);
    if (share > tx.amount) throw new HttpError(400, '相手の負担が支払った金額を超えています');
    const entry: Entry = {
      id: newEntryId(tx.date),
      type: 'split',
      date: tx.date,
      title: tx.merchant || tx.memo || '家計簿の明細',
      memo: str(b.memo, 300),
      from: c.me,
      to: c.partner.sub,
      amount: tx.amount,
      share,
      createdBy: c.me,
      createdAt: now,
    };
    // 相手の家計簿に負担分。カテゴリーは自分の明細と同じもの (相手になければ相手の家計簿に作る)
    const categoryId = share > 0 ? await partnerCategoryId(c.me, c.partner.sub, tx.categoryId) : null;
    const otherTxId =
      share > 0
        ? await db.createKakeiboTx(c.partner.sub, {
            date: tx.date,
            amount: share,
            categoryId,
            merchant: entry.title,
            split: { entryId: entry.id, role: 'partner' },
          })
        : undefined;
    entry.kakeibo = { payerTxId: tx.id, payerCreated: false, otherTxId };
    await db.putEntry(c.pair.id, entry);
    await db.setKakeiboSplit(c.me, tx.id, { entryId: entry.id, role: 'payer', otherShare: share });
    if (otherTxId) await notifyPartner(c, entry);
    return entry;
  }

  // waripo で直接入力: 払ったのは自分か相手
  const amount = yenOf(b.amount);
  const share = b.share === undefined || b.share === '' ? halfShare(amount) : yenOf(b.share, true);
  if (share > amount) throw new HttpError(400, '立て替えてもらった人の負担が合計を超えています');
  const payer = b.payer === 'partner' ? c.partner.sub : c.me;
  const other = payer === c.me ? c.partner.sub : c.me;
  const date = isDate(b.date) ? b.date : todayJst();
  const title = str(b.title, 100) || '割り勘';
  const entry: Entry = {
    id: newEntryId(date),
    type: 'split',
    date,
    title,
    memo: str(b.memo, 300),
    from: payer,
    to: other,
    amount,
    share,
    createdBy: c.me,
    createdAt: now,
  };
  if (b.syncKakeibo !== false) {
    // 2 人の家計簿にも記録する (払った人は支払い全体、相手は自分の負担分)
    const payerTxId = await db.createKakeiboTx(payer, {
      date,
      amount,
      categoryId: null,
      merchant: title,
      split: { entryId: entry.id, role: 'payer', otherShare: share },
    });
    const otherTxId =
      share > 0
        ? await db.createKakeiboTx(other, { date, amount: share, categoryId: null, merchant: title, split: { entryId: entry.id, role: 'partner' } })
        : undefined;
    entry.kakeibo = { payerTxId, payerCreated: true, otherTxId };
  }
  await db.putEntry(c.pair.id, entry);
  if (entry.kakeibo) await notifyPartner(c, entry);
  return entry;
}

/** 精算 (direction: 'toPartner' = 自分が相手に返した / 'toMe' = 相手から受け取った) と、最初の残高 */
function transfer(c: Ctx, b: Record<string, unknown>, type: 'settle' | 'initial'): Entry {
  const amount = yenOf(b.amount);
  const date = isDate(b.date) ? b.date : todayJst();
  // settle: from = 返した人。initial: from = 貸している人
  const meFirst = type === 'settle' ? b.direction === 'toPartner' : b.direction === 'partnerOwesMe';
  if (type === 'settle' && b.direction !== 'toPartner' && b.direction !== 'toMe') throw new HttpError(400, 'direction が不正です');
  if (type === 'initial' && b.direction !== 'partnerOwesMe' && b.direction !== 'iOwePartner') throw new HttpError(400, 'direction が不正です');
  return {
    id: newEntryId(date),
    type,
    date,
    title: str(b.title, 100) || (type === 'settle' ? '精算' : '最初の残高'),
    memo: str(b.memo, 300),
    from: meFirst ? c.me : c.partner.sub,
    to: meFirst ? c.partner.sub : c.me,
    amount,
    createdBy: c.me,
    createdAt: new Date().toISOString(),
  };
}

/** 記録を消す。家計簿の明細も元に戻す */
async function removeEntry(c: Ctx, id: string): Promise<void> {
  const e = await db.getEntry(c.pair.id, id);
  if (!e) throw new HttpError(404, '記録が見つかりません');
  if (e.kakeibo?.otherTxId) await db.deleteKakeiboTx(e.to, e.kakeibo.otherTxId);
  if (e.kakeibo?.payerTxId) {
    if (e.kakeibo.payerCreated) await db.deleteKakeiboTx(e.from, e.kakeibo.payerTxId);
    else await db.setKakeiboSplit(e.from, e.kakeibo.payerTxId, null);
  }
  await db.deleteEntry(c.pair.id, id);
}

async function route(event: APIGatewayProxyEventV2WithJWTAuthorizer, me: string): Promise<APIGatewayProxyStructuredResultV2> {
  switch (event.routeKey) {
    case 'GET /api/summary': {
      const pair = await db.pairOf(me);
      const meMember = pair?.members.find((m) => m.sub === me) ?? (await db.userBySub(me)) ?? { sub: me, email: '' };
      const entries = pair ? await db.listEntries(pair.id) : [];
      const res: Summary = {
        me: meMember,
        pair,
        partner: pair?.members.find((m) => m.sub !== me) ?? null,
        balance: balanceFor(me, entries),
        entries,
      };
      return json(200, res);
    }

    case 'POST /api/pair': {
      if (await db.pairOf(me)) throw new HttpError(400, 'すでに割り勘の相手が登録されています');
      const email = str(parseBody(event).partnerEmail, 254).toLowerCase();
      if (!EMAIL_RE.test(email)) throw new HttpError(400, '相手のメールアドレスを正しく入力してください');
      const partner = await db.userByEmail(email);
      if (!partner) throw new HttpError(404, 'そのメールアドレスの W-SSO アカウントがありません。ダッシュボードで追加してください');
      if (partner.sub === me) throw new HttpError(400, '自分自身とはペアになれません');
      if (await db.pairOf(partner.sub)) throw new HttpError(400, '相手はすでに別の人とペアになっています');
      const self = await db.userBySub(me);
      if (!self) throw new HttpError(500, '自分のアカウントが見つかりません');
      try {
        return json(201, await db.createPair(self, partner));
      } catch (e) {
        if ((e as Error).name === 'TransactionCanceledException') throw new HttpError(409, 'どちらかがすでにペアになっています');
        throw e;
      }
    }

    case 'POST /api/entries': {
      const c = await requirePair(me);
      const b = parseBody(event);
      if (b.type === 'split') return json(201, await createSplit(c, b));
      if (b.type === 'settle' || b.type === 'initial') {
        const entry = transfer(c, b, b.type);
        await db.putEntry(c.pair.id, entry);
        return json(201, entry);
      }
      throw new HttpError(400, 'type は split / settle / initial のどれかです');
    }

    case 'DELETE /api/entries/{id}': {
      const c = await requirePair(me);
      await removeEntry(c, decodeURIComponent(event.pathParameters?.id ?? ''));
      return json(200, { ok: true });
    }

    default:
      throw new HttpError(404, 'Not Found');
  }
}

export async function handler(event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> {
  try {
    const claims = event.requestContext.authorizer?.jwt?.claims ?? {};
    const me = typeof claims.sub === 'string' ? claims.sub : '';
    if (!me) throw new HttpError(401, 'ログインが必要です');
    const groups = groupsFromClaim(claims['cognito:groups']);
    if (!groups.includes('admin') && !groups.includes(APP_GROUP)) {
      throw new HttpError(403, 'waripo を使う権限がありません。ダッシュボード (apps.wakalabo.net) の管理者に追加してもらってください');
    }
    return await route(event, me);
  } catch (e) {
    if (e instanceof HttpError) return json(e.status, { message: e.message });
    // AWS の内部の情報 (ARN など) を画面に出さない。詳細は CloudWatch Logs に残る
    console.error(e);
    return json(500, { message: 'waripo でエラーが発生しました。時間をおいてもう一度お試しください' });
  }
}
