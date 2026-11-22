// DynamoDB に依存しない計算 (テストしやすいように分けている)
import type { Entry } from './types.js';

/** 日本時間の今日を YYYY-MM-DD で返す */
export function todayJst(now = new Date()): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(now);
}

export const isDate = (s: unknown): s is string =>
  typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !Number.isNaN(Date.parse(s));

/** 金額を整数の円にする ("¥1,234" や全角も可)。0 以下はエラー */
export function parseYen(raw: unknown, allowZero = false): number {
  const n = typeof raw === 'number' ? raw : Number(String(raw ?? '').normalize('NFKC').replace(/[^\d.]/g, ''));
  if (!Number.isFinite(n) || n < 0 || (!allowZero && n === 0)) throw new Error('金額が正しくありません');
  return Math.round(n);
}

/** 半分ずつのときの、立て替えてもらった人の負担。端数 (1 円) は払った人が持つ */
export const halfShare = (total: number) => Math.floor(total / 2);

/**
 * 自分から見た残高。正なら相手が自分に借りている。
 * どの記録も「from から to へお金が流れた分だけ、to が from に借りる」として足し合わせる
 */
export function balanceFor(me: string, entries: Entry[]): number {
  let b = 0;
  for (const e of entries) {
    const lent = e.type === 'split' ? (e.share ?? 0) : e.amount;
    if (e.from === me) b += lent;
    if (e.to === me) b -= lent;
  }
  return b;
}

/** JWT の cognito:groups (API Gateway では "[admin other]" のような文字列で届くことがある) */
export function groupsFromClaim(claim: unknown): string[] {
  if (Array.isArray(claim)) return claim.map(String);
  if (typeof claim !== 'string') return [];
  return claim
    .replace(/^\[|\]$/g, '')
    .split(/[\s,]+/)
    .map((s) => s.replace(/^"|"$/g, ''))
    .filter(Boolean);
}

export const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;
