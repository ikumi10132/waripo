import { useState, type FormEvent, type ReactNode } from 'react';
import type { Member } from '../../../api/src/types';
import { api } from '../api';
import { nameOf, todayJst, yen } from '../util';

interface Common {
  partner: Member;
  onClose: () => void;
  onDone: (message: string) => void;
  onError: (e: unknown) => void;
}

function Sheet({ title, children, onClose, onSubmit, busy, submitLabel }: {
  title: string;
  children: ReactNode;
  onClose: () => void;
  onSubmit: (e: FormEvent) => void;
  busy: boolean;
  submitLabel: string;
}) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <form className="sheet" onClick={(e) => e.stopPropagation()} onSubmit={onSubmit} aria-label={title}>
        <div className="sheet-head">
          <button type="button" className="btn btn-ghost btn-small" onClick={onClose}>閉じる</button>
          <h2>{title}</h2>
          <span />
        </div>
        {children}
        <div className="sheet-foot">
          <button type="submit" className="btn btn-primary btn-block btn-large" disabled={busy}>{submitLabel}</button>
        </div>
      </form>
    </div>
  );
}

const digits = (s: string) => Number(s.replace(/[^\d]/g, '')) || 0;
const fmt = (s: string) => (s === '' ? '' : digits(s).toLocaleString('ja-JP'));

/** 割り勘を追加 (waripo で直接) */
export function SplitForm({ partner, onClose, onDone, onError }: Common) {
  const [title, setTitle] = useState('');
  const [date, setDate] = useState(todayJst());
  const [amount, setAmount] = useState('');
  const [payer, setPayer] = useState<'me' | 'partner'>('me');
  const [half, setHalf] = useState(true);
  const [share, setShare] = useState('');
  const [sync, setSync] = useState(true);
  const [busy, setBusy] = useState(false);
  const total = digits(amount);
  const otherShare = half ? Math.floor(total / 2) : digits(share);
  const payerShare = total - otherShare;
  const pName = nameOf(partner);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!total) return onError(new Error('金額を入力してください'));
    if (otherShare > total) return onError(new Error('負担額が合計を超えています'));
    setBusy(true);
    try {
      await api.addEntry({ type: 'split', title: title.trim() || '割り勘', date, amount: total, payer, share: otherShare, syncKakeibo: sync });
      onDone(`${yen(total)} の割り勘を記録しました`);
    } catch (err) {
      onError(err);
      setBusy(false);
    }
  };

  return (
    <Sheet title="割り勘を追加" onClose={onClose} onSubmit={submit} busy={busy} submitLabel="記録する">
      <label className="field">
        <span>合計金額</span>
        <div className="amount-input">
          <span aria-hidden>¥</span>
          <input className="input" inputMode="numeric" placeholder="0" autoFocus value={fmt(amount)} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
        </div>
      </label>
      <label className="field">
        <span>内容</span>
        <input className="input" placeholder="例: スーパー、夕食" value={title} onChange={(e) => setTitle(e.target.value)} maxLength={100} />
      </label>
      <div className="field">
        <span>払った人</span>
        <div className="segmented" role="group" aria-label="払った人">
          <button type="button" className={payer === 'me' ? 'active' : ''} aria-pressed={payer === 'me'} onClick={() => setPayer('me')}>自分</button>
          <button type="button" className={payer === 'partner' ? 'active' : ''} aria-pressed={payer === 'partner'} onClick={() => setPayer('partner')}>{pName}</button>
        </div>
      </div>
      <div className="field">
        <span>分け方</span>
        <div className="segmented" role="group" aria-label="分け方">
          <button type="button" className={half ? 'active' : ''} aria-pressed={half} onClick={() => setHalf(true)}>半分ずつ</button>
          <button type="button" className={!half ? 'active' : ''} aria-pressed={!half} onClick={() => setHalf(false)}>金額を指定</button>
        </div>
      </div>
      {!half && (
        <label className="field">
          <span>{payer === 'me' ? pName : '自分'}の負担</span>
          <div className="amount-input small-amount">
            <span aria-hidden>¥</span>
            <input className="input" inputMode="numeric" value={fmt(share)} onChange={(e) => setShare(e.target.value.replace(/[^\d]/g, ''))} />
          </div>
        </label>
      )}
      <div className="info-box small">
        <span>{payer === 'me' ? '自分' : pName}の負担: <strong>{yen(Math.max(0, payerShare))}</strong></span>
        <span>{payer === 'me' ? pName : '自分'}の負担: <strong>{yen(otherShare)}</strong>（{payer === 'me' ? '貸し' : '借り'}）</span>
      </div>
      <label className="field">
        <span>日付</span>
        <input className="input" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
      </label>
      <label className="switch-row advance-box">
        <span>
          <strong>MyKakeibo! にも記録する</strong>
          <span className="muted small"> 2 人の MyKakeibo! に、それぞれの分を入れます</span>
        </span>
        <input type="checkbox" role="switch" checked={sync} onChange={(e) => setSync(e.target.checked)} />
      </label>
    </Sheet>
  );
}

/** 精算する (返した / 受け取った) */
export function SettleForm({ partner, balance, onClose, onDone, onError }: Common & { balance: number }) {
  const [amount, setAmount] = useState(String(Math.abs(balance) || ''));
  const [direction, setDirection] = useState<'toPartner' | 'toMe'>(balance > 0 ? 'toMe' : 'toPartner');
  const [busy, setBusy] = useState(false);
  const pName = nameOf(partner);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = digits(amount);
    if (!n) return onError(new Error('金額を入力してください'));
    setBusy(true);
    try {
      await api.addEntry({ type: 'settle', amount: n, direction });
      onDone(`${yen(n)} の精算を記録しました`);
    } catch (err) {
      onError(err);
      setBusy(false);
    }
  };

  return (
    <Sheet title="精算する" onClose={onClose} onSubmit={submit} busy={busy} submitLabel="精算を記録する">
      <div className="segmented" role="group" aria-label="お金の向き">
        <button type="button" className={direction === 'toMe' ? 'active' : ''} aria-pressed={direction === 'toMe'} onClick={() => setDirection('toMe')}>{pName} から受け取った</button>
        <button type="button" className={direction === 'toPartner' ? 'active' : ''} aria-pressed={direction === 'toPartner'} onClick={() => setDirection('toPartner')}>{pName} に返した</button>
      </div>
      <label className="field">
        <span>金額</span>
        <div className="amount-input">
          <span aria-hidden>¥</span>
          <input className="input" inputMode="numeric" value={fmt(amount)} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
        </div>
      </label>
      <p className="muted small">今の残高ぶんが最初から入っています。一部だけ返したときは金額を変えてください。精算は MyKakeibo! には記録しません（支出ではなく貸し借りの清算のため）。</p>
    </Sheet>
  );
}

/** 最初の残高 (Warica などから引き継ぐ) */
export function InitialForm({ partner, onClose, onDone, onError }: Common) {
  const [amount, setAmount] = useState('');
  const [direction, setDirection] = useState<'partnerOwesMe' | 'iOwePartner'>('partnerOwesMe');
  const [busy, setBusy] = useState(false);
  const pName = nameOf(partner);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = digits(amount);
    if (!n) return onError(new Error('金額を入力してください'));
    setBusy(true);
    try {
      await api.addEntry({ type: 'initial', amount: n, direction, memo: 'Warica から引き継ぎ' });
      onDone('最初の残高を記録しました');
    } catch (err) {
      onError(err);
      setBusy(false);
    }
  };

  return (
    <Sheet title="最初の残高" onClose={onClose} onSubmit={submit} busy={busy} submitLabel="記録する">
      <p className="small">Warica などで今残っている貸し借りを 1 件だけ入れて、そこから waripo を始めます。</p>
      <div className="segmented" role="group" aria-label="どちらが借りているか">
        <button type="button" className={direction === 'partnerOwesMe' ? 'active' : ''} aria-pressed={direction === 'partnerOwesMe'} onClick={() => setDirection('partnerOwesMe')}>{pName} が借りている</button>
        <button type="button" className={direction === 'iOwePartner' ? 'active' : ''} aria-pressed={direction === 'iOwePartner'} onClick={() => setDirection('iOwePartner')}>自分が借りている</button>
      </div>
      <label className="field">
        <span>金額</span>
        <div className="amount-input">
          <span aria-hidden>¥</span>
          <input className="input" inputMode="numeric" autoFocus value={fmt(amount)} onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))} />
        </div>
      </label>
    </Sheet>
  );
}
