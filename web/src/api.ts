import type { Entry, Pair, Summary } from '../../api/src/types';
import { getConfig } from './config';
import { getAccessToken } from './wsso-client';

export class AuthError extends Error {}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const token = await getAccessToken();
  if (!token) throw new AuthError('ログインが必要です');
  const res = await fetch(`${getConfig().apiUrl}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  if (res.status === 401) throw new AuthError('ログインの有効期限が切れました');
  const body = (await res.json().catch(() => ({}))) as T & { message?: string };
  if (!res.ok) throw new Error(body.message ?? `エラーが発生しました (${res.status})`);
  return body;
}

const send = <T>(method: string, path: string, body?: unknown) =>
  call<T>(path, { method, body: body === undefined ? undefined : JSON.stringify(body) });

export interface SplitInput {
  type: 'split';
  title: string;
  date: string;
  amount: number;
  payer: 'me' | 'partner';
  /** 立て替えてもらった人の負担。省略で半分 */
  share?: number;
  memo?: string;
  syncKakeibo: boolean;
}
export interface TransferInput {
  type: 'settle' | 'initial';
  amount: number;
  date?: string;
  direction: 'toPartner' | 'toMe' | 'partnerOwesMe' | 'iOwePartner';
  memo?: string;
}

export const api = {
  summary: () => call<Summary>('/summary'),
  createPair: (partnerEmail: string) => send<Pair>('POST', '/pair', { partnerEmail }),
  acceptPair: () => send<{ ok: true }>('POST', '/pair/accept'),
  cancelPair: () => send<{ ok: true }>('DELETE', '/pair'),
  addEntry: (input: SplitInput | TransferInput) => send<Entry>('POST', '/entries', input),
  deleteEntry: (id: string) => send<{ ok: true }>('DELETE', `/entries/${encodeURIComponent(id)}`),
};
