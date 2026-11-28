import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { Entry, Summary } from '../../api/src/types';
import { api, AuthError } from './api';
import { IconApps, IconGear, IconHome, IconLogout, IconPlus, IconScale } from './components/Icons';
import { InitialForm, SettleForm, SplitForm } from './components/Forms';
import { getConfig, loadConfig } from './config';
import { dateLabel, effectFor, monthLabel, myShare, nameOf, yen } from './util';
import { handleRedirect, isLoggedIn, login, logout, getAccessToken } from './wsso-client';
import { initLog, logView } from './wakalabo-log';

type Phase = { name: 'loading' } | { name: 'login' } | { name: 'ready' } | { name: 'error'; message: string };

export function App() {
  const [phase, setPhase] = useState<Phase>({ name: 'loading' });
  useEffect(() => {
    (async () => {
      try {
        await loadConfig();
        handleRedirect();
        setPhase(isLoggedIn() ? { name: 'ready' } : { name: 'login' });
      } catch (e) {
        setPhase({ name: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, []);

  if (phase.name === 'loading') return <div className="center muted">読み込み中…</div>;
  if (phase.name === 'error') {
    return (
      <div className="center">
        <p className="error-text">{phase.message}</p>
        <button className="btn" onClick={() => location.reload()}>再読み込み</button>
      </div>
    );
  }
  if (phase.name === 'login') {
    return (
      <div className="center login">
        <img src="/icon.svg" alt="" width={64} height={64} />
        <h1>waripo</h1>
        <p className="muted">2 人の割り勘と貸し借り</p>
        <button className="btn btn-primary btn-wide" onClick={() => login()}>W-SSO でログイン</button>
      </div>
    );
  }
  return <Main onAuthError={() => setPhase({ name: 'login' })} />;
}

type Tab = 'home' | 'settings';
type Modal = null | 'split' | 'settle' | 'initial' | { entry: Entry };

/** ログに出す画面の名前 */
const SCREEN_NAMES: Record<Tab, string> = { home: 'ホーム', settings: '設定' };

function Main({ onAuthError }: { onAuthError: () => void }) {
  const [tab, setTab] = useState<Tab>('home');
  // 共通のログ (どの画面を開いたか・画面のエラー)。apps.wakalabo.net の「ログ」で見られる
  useEffect(() => initLog({ url: getConfig().logUrl, app: 'waripo', getToken: getAccessToken }), []);
  useEffect(() => logView(SCREEN_NAMES[tab]), [tab]);
  const [data, setData] = useState<Summary | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [toastMsg, setToastMsg] = useState<{ text: string; error?: boolean } | null>(null);

  const toast = useCallback((text: string, error = false) => {
    setToastMsg({ text, error });
    window.setTimeout(() => setToastMsg((t) => (t?.text === text ? null : t)), 3500);
  }, []);
  const handleError = useCallback(
    (e: unknown) => {
      if (e instanceof AuthError) return onAuthError();
      toast(e instanceof Error ? e.message : String(e), true);
    },
    [onAuthError, toast],
  );
  const reload = useCallback(() => api.summary().then(setData, handleError), [handleError]);

  useEffect(() => {
    void reload();
    const onVisible = () => document.visibilityState === 'visible' && void reload();
    document.addEventListener('visibilitychange', onVisible);
    return () => document.removeEventListener('visibilitychange', onVisible);
  }, [reload]);

  const done = (message: string) => {
    setModal(null);
    toast(message);
    void reload();
  };
  const go = (t: Tab) => {
    setTab(t);
    window.scrollTo({ top: 0 });
  };
  const ready = !!data?.partner;

  return (
    <div className="shell">
      <aside className="sidebar" aria-label="メインメニュー">
        <div className="brand">
          <img src="/icon.svg" alt="" width={36} height={36} />
          <span className="brand-text">
            <strong>waripo</strong>
            <span className="muted small">{data?.partner ? `${nameOf(data.me)} と ${nameOf(data.partner)}` : '2 人の割り勘'}</span>
          </span>
        </div>
        {ready && (
          <button className="btn btn-primary btn-block" onClick={() => setModal('split')}>
            <IconPlus /> 割り勘を追加
          </button>
        )}
        <nav>
          <ul className="side-nav">
            <li><button className={tab === 'home' ? 'active' : ''} aria-current={tab === 'home' ? 'page' : undefined} onClick={() => go('home')}><IconHome /><span className="grow">ホーム</span></button></li>
            <li><button className={tab === 'settings' ? 'active' : ''} aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => go('settings')}><IconGear /><span className="grow">設定</span></button></li>
          </ul>
        </nav>
        <ul className="side-nav side-foot">
          <li><button onClick={() => window.open('https://apps.wakalabo.net', '_blank')}><IconApps /><span className="grow">アプリ一覧</span></button></li>
          <li><button onClick={logout}><IconLogout /><span className="grow">ログアウト</span></button></li>
        </ul>
      </aside>

      <main className="main">
        {!data && <p className="muted center-text">読み込み中…</p>}
        {data && !data.partner && <Setup onDone={done} onError={handleError} />}
        {data?.partner && tab === 'home' && <Home data={data} onModal={setModal} />}
        {data?.partner && tab === 'settings' && <Settings data={data} onModal={setModal} />}
      </main>

      {ready && (
        <nav className="tabbar" style={{ gridTemplateColumns: 'repeat(3, minmax(0, 1fr))' }} aria-label="画面の切り替え">
          <button className={tab === 'home' ? 'active' : ''} aria-current={tab === 'home' ? 'page' : undefined} onClick={() => go('home')}><IconHome size={24} /><span>ホーム</span></button>
          <button className="tab-add" aria-label="割り勘を追加" onClick={() => setModal('split')}><IconPlus size={28} /></button>
          <button className={tab === 'settings' ? 'active' : ''} aria-current={tab === 'settings' ? 'page' : undefined} onClick={() => go('settings')}><IconGear size={24} /><span>設定</span></button>
        </nav>
      )}

      {data?.partner && modal === 'split' && <SplitForm partner={data.partner} onClose={() => setModal(null)} onDone={done} onError={handleError} />}
      {data?.partner && modal === 'settle' && (
        <SettleForm partner={data.partner} balance={data.balance} onClose={() => setModal(null)} onDone={done} onError={handleError} />
      )}
      {data?.partner && modal === 'initial' && <InitialForm partner={data.partner} onClose={() => setModal(null)} onDone={done} onError={handleError} />}
      {data && modal && typeof modal === 'object' && (
        <EntryDetail data={data} entry={modal.entry} onClose={() => setModal(null)} onDone={done} onError={handleError} />
      )}

      {toastMsg && <div className={`toast${toastMsg.error ? ' toast-error' : ''}`} role="status">{toastMsg.text}</div>}
    </div>
  );
}

/** 残高と、これまでの記録 */
function Home({ data, onModal }: { data: Summary; onModal: (m: Modal) => void }) {
  const pName = nameOf(data.partner);
  const b = data.balance;
  const byMonth = new Map<string, Entry[]>();
  for (const e of data.entries) byMonth.set(e.date.slice(0, 7), [...(byMonth.get(e.date.slice(0, 7)) ?? []), e]);

  return (
    <>
      <header className="page-head">
        <h1 className="page-title">ホーム</h1>
        <div className="head-actions pc-only">
          <button className="btn btn-outline" onClick={() => onModal('settle')} disabled={b === 0}><IconScale /> 精算する</button>
          <button className="btn btn-primary" onClick={() => onModal('split')}><IconPlus /> 割り勘を追加</button>
        </div>
      </header>

      <section className="card balance-card" aria-label="残高">
        <p className="kpi-label">いまの貸し借り</p>
        {b === 0 ? (
          <p className="balance-text">貸し借りはありません</p>
        ) : (
          <p className="balance-text">
            {b > 0 ? <>{pName} が<strong>あなた</strong>に</> : <><strong>あなた</strong>が {pName} に</>}
            <span className={`balance-amount ${b > 0 ? 'income' : 'warn'}`}>{yen(Math.abs(b))}</span>
            借りています
          </p>
        )}
        <button className="btn btn-outline phone-only" onClick={() => onModal('settle')} disabled={b === 0}><IconScale /> 精算する</button>
      </section>

      {data.entries.length === 0 && (
        <section className="card">
          <p className="muted">まだ記録がありません。「割り勘を追加」か、MyKakeibo! の明細の「waripo で割り勘」から始めてください。</p>
          <p className="muted small">Warica などの残高を引き継ぐときは、設定の「最初の残高」から入れてください。</p>
        </section>
      )}

      {[...byMonth.entries()].map(([month, list]) => (
        <section key={month} className="day">
          <h2 className="day-head"><span>{monthLabel(`${month}-01`)}</span></h2>
          <ul className="card list">
            {list.map((e) => <EntryRow key={e.id} me={data.me.sub} partnerName={pName} entry={e} onClick={() => onModal({ entry: e })} />)}
          </ul>
        </section>
      ))}
    </>
  );
}

function describe(me: string, partnerName: string, e: Entry): string {
  if (e.type === 'split') return `${e.from === me ? 'あなた' : partnerName}が払った・合計 ${yen(e.amount)}`;
  if (e.type === 'settle') return e.from === me ? `あなたが ${partnerName} に返した` : `${partnerName} から受け取った`;
  return 'Warica などからの最初の残高';
}

function EntryRow({ me, partnerName, entry: e, onClick }: { me: string; partnerName: string; entry: Entry; onClick: () => void }) {
  const eff = effectFor(me, e);
  return (
    <li>
      <button className="tx-row" onClick={onClick}>
        <span className="tx-icon entry-icon" aria-hidden>{e.type === 'split' ? '割' : e.type === 'settle' ? '精' : '初'}</span>
        <span className="tx-main">
          <span className="tx-title">{e.title}</span>
          <span className="tx-meta">
            {dateLabel(e.date)}・{describe(me, partnerName, e)}
            {e.kakeibo && <span className="tag" style={{ marginLeft: 6 }}>MyKakeibo!</span>}
          </span>
        </span>
        <span className={`num tx-amount ${eff > 0 ? 'income' : eff < 0 ? 'warn' : ''}`}>
          {eff > 0 ? '貸し ' : eff < 0 ? '借り ' : ''}{yen(Math.abs(eff))}
        </span>
      </button>
    </li>
  );
}

function EntryDetail({ data, entry: e, onClose, onDone, onError }: {
  data: Summary;
  entry: Entry;
  onClose: () => void;
  onDone: (m: string) => void;
  onError: (e: unknown) => void;
}) {
  const [busy, setBusy] = useState(false);
  const me = data.me.sub;
  const pName = nameOf(data.partner);
  const mine = myShare(me, e);
  const remove = async () => {
    if (!confirm(`この記録を削除しますか？${e.kakeibo ? '\nMyKakeibo! の明細も元に戻します (waripo が作った明細は削除します)。' : ''}`)) return;
    setBusy(true);
    try {
      await api.deleteEntry(e.id);
      onDone('削除しました');
    } catch (err) {
      onError(err);
      setBusy(false);
    }
  };
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <div className="sheet" onClick={(ev) => ev.stopPropagation()}>
        <div className="sheet-head">
          <button className="btn btn-ghost btn-small" onClick={onClose}>閉じる</button>
          <h2>{e.title}</h2>
          <span />
        </div>
        <dl className="kv detail-kv">
          <dt>日付</dt><dd>{dateLabel(e.date)}</dd>
          <dt>内容</dt><dd>{describe(me, pName, e)}</dd>
          {mine !== null && (<><dt>あなたの負担</dt><dd>{yen(mine)}</dd></>)}
          {e.type === 'split' && (<><dt>{pName} の負担</dt><dd>{yen(e.amount - (mine ?? 0))}</dd></>)}
          {e.type !== 'split' && (<><dt>金額</dt><dd>{yen(e.amount)}</dd></>)}
          {e.memo && (<><dt>メモ</dt><dd>{e.memo}</dd></>)}
          {e.kakeibo && (<><dt>MyKakeibo!</dt><dd>2 人の MyKakeibo! に記録済み</dd></>)}
        </dl>
        <button className="btn btn-danger" onClick={() => void remove()} disabled={busy}>この記録を削除</button>
        <div className="sheet-foot"><button className="btn btn-block" onClick={onClose}>閉じる</button></div>
      </div>
    </div>
  );
}

/** 最初に 1 回: 割り勘の相手を登録する */
function Setup({ onDone, onError }: { onDone: (m: string) => void; onError: (e: unknown) => void }) {
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    setBusy(true);
    try {
      await api.createPair(email.trim());
      onDone('相手を登録しました');
    } catch (err) {
      onError(err);
      setBusy(false);
    }
  };
  return (
    <>
      <header className="page-head"><h1 className="page-title">はじめに</h1></header>
      <section className="card">
        <h2 className="card-title">割り勘の相手を登録</h2>
        <p className="small">相手の W-SSO のメールアドレスを入れてください。登録は 2 人のうちどちらか 1 回だけで、相手の画面にも自動で反映されます。</p>
        <form className="admin-form" onSubmit={submit}>
          <label className="field">
            <span>相手のメールアドレス</span>
            <input className="input" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          </label>
          <button className="btn btn-primary" disabled={busy}>登録する</button>
        </form>
      </section>
    </>
  );
}

function Settings({ data, onModal }: { data: Summary; onModal: (m: Modal) => void }) {
  return (
    <>
      <header className="page-head"><h1 className="page-title">設定</h1></header>
      <section className="card">
        <h2 className="card-title">割り勘の相手</h2>
        <dl className="kv detail-kv">
          <dt>あなた</dt><dd>{data.me.email}</dd>
          <dt>相手</dt><dd>{data.partner?.email}</dd>
        </dl>
      </section>
      <section className="card">
        <h2 className="card-title">最初の残高</h2>
        <p className="small">Warica などで今残っている貸し借りを引き継ぎます。</p>
        <button className="btn btn-outline" onClick={() => onModal('initial')}>最初の残高を入れる</button>
      </section>
      <section className="card">
        <h2 className="card-title">MyKakeibo! との連動</h2>
        <p className="small">
          MyKakeibo! で明細を記録するとき、または明細を開いて「waripo で割り勘」を押すと、ここに記録されます。あなたの MyKakeibo! は自分の負担分だけが支出になり、相手の MyKakeibo! には相手の負担分が「waripoから自動登録」として、同じカテゴリーで入ります。
        </p>
      </section>
      <button className="btn btn-ghost phone-only" onClick={logout}>ログアウト</button>
    </>
  );
}
