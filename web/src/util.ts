import type { Entry, Member } from '../../api/src/types';

export const yen = (n: number) => `¥${n.toLocaleString('ja-JP')}`;

export function todayJst(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Tokyo' }).format(new Date());
}

const WEEK = ['日', '月', '火', '水', '木', '金', '土'];
export function dateLabel(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return `${m}/${d} (${WEEK[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]})`;
}

export const monthLabel = (date: string) => `${date.slice(0, 4)}年${Number(date.slice(5, 7))}月`;

/** メールアドレスの @ より前を名前代わりに使う */
export const nameOf = (m: Member | null | undefined) => (m ? m.email.split('@')[0]! : '相手');

/** 自分から見た、その記録での貸し借り (正: 相手に貸した、負: 相手に借りた) */
export function effectFor(me: string, e: Entry): number {
  const lent = e.type === 'split' ? (e.share ?? 0) : e.amount;
  return e.from === me ? lent : e.to === me ? -lent : 0;
}

/** 自分の負担額 (割り勘のときだけ) */
export function myShare(me: string, e: Entry): number | null {
  if (e.type !== 'split') return null;
  return e.from === me ? e.amount - (e.share ?? 0) : (e.share ?? 0);
}
