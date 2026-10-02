import { useEffect, useState, useCallback, FormEvent } from 'react';
const AUTH_KEY = 'mpesa_groups_basic_auth';
const KSh = (n: number) => 'KSh ' + Number(n).toLocaleString();
const getAuth = () => sessionStorage.getItem(AUTH_KEY) || '';
const setAuth = (username: string, password: string) => sessionStorage.setItem(AUTH_KEY, btoa(username + ':' + password));
const clearAuth = () => sessionStorage.removeItem(AUTH_KEY);
function authRequired() { window.dispatchEvent(new Event('mpesa-auth-required')); }
async function api(p: string, body?: any): Promise<any> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  const auth = getAuth(); if (auth) headers.Authorization = 'Basic ' + auth;
  const r = await fetch('/api' + p, { method: body ? 'POST' : 'GET', headers, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({ error: r.statusText || 'Request failed' })); d._s = r.status;
  if (r.status === 401) authRequired();
  return d;
}
const Tag = ({ s, c }: { s: string; c?: string }) => <span className={'tag ' + (c || s)}>{s}</span>;
const Results = ({ rows }: { rows: any[] }) => <div className="w"><table><tbody>{rows.map((r, i) => <tr key={i}><td>{r.customer || '-'}</td><td>{KSh(r.amount)}</td><td><Tag s={r.result} /></td><td>{r.detail}</td></tr>)}</tbody></table></div>;
function useHash() { const [h, s] = useState(location.hash); useEffect(() => { const f = () => s(location.hash); addEventListener('hashchange', f); return () => removeEventListener('hashchange', f); }, []); return h.split('/'); }

export default function App() {
  const [, p, id] = useHash(); const [env, setEnv] = useState<any>(null);
  const [loggedIn, setLoggedIn] = useState(() => !!getAuth());
  useEffect(() => {
    api('/health').then(setEnv);
    const onAuth = () => setLoggedIn(false);
    addEventListener('mpesa-auth-required', onAuth);
    return () => removeEventListener('mpesa-auth-required', onAuth);
  }, []);
  const logout = () => { clearAuth(); setLoggedIn(false); };
  if (!loggedIn) return <Login onLogin={() => setLoggedIn(true)} env={env} />;
  return <>
    <div className="top"><b>M-Pesa Groups</b><a href="#/">Dashboard</a><a href="#/import">Import Customers</a><a href="#/payments">Payments</a><button className="s" onClick={logout}>Logout</button></div>
    {env?.env && <div className={'banner ' + (env.env === 'production' ? 'prod' : 'sbx')}>{env.env === 'production' ? 'PRODUCTION: real money' + (env.productionUnlocked ? '' : ' (locked until verified)') : 'SANDBOX: test mode, no real money'}</div>}
    <main>{p === 'g' ? <Group id={+id} /> : p === 'import' ? <Import /> : p === 'payments' ? <Pays /> : <Dash env={env} />}</main>
  </>;
}

function Login({ onLogin, env }: { onLogin: () => void; env: any }) {
  const [username, setUsername] = useState('admin'), [password, setPassword] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault(); setError('');
    if (!username.trim() || !password) return setError('Enter a username and password.');
    setBusy(true); setAuth(username.trim(), password);
    const r = await api('/groups');
    setBusy(false);
    if (r._s === 200 && r.groups) onLogin();
    else { clearAuth(); setError(r._s === 401 ? 'Incorrect password.' : (r.error || 'Login failed.')); }
  };
  return <main><div className="card" style={{ maxWidth: 430, margin: '10vh auto' }}>
    <h2>M-Pesa Groups Login</h2>
    {env?.env === 'production' ? <p><small>Production app. Your password is checked by the server and is not stored in the browser.</small></p> : <p><small>Enter the ADMIN_PASSWORD configured on the server.</small></p>}
    <form onSubmit={submit}>
      <label>Username<input value={username} onChange={e => setUsername(e.target.value)} autoComplete="username" /></label>
      <label>Password<input type="password" value={password} onChange={e => setPassword(e.target.value)} autoComplete="current-password" /></label>
      {error && <p className="err">{error}</p>}
      <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
    </form>
  </div></main>;
}

function Dash({ env }: { env: any }) {
  const [d, setD] = useState<any>(null), [v, setV] = useState<any>(null);
  useEffect(() => { api('/groups').then(setD); }, []);
  useEffect(() => { if (env?.env === 'sandbox') api('/verification').then(setV); }, [env]);
  if (!d) return <p>Loading…</p>; if (!d.groups) return <p className="err">{d.error || 'Failed to load'}</p>;
  const t = d.totals;
  return <>
    <div className="grid">{[['Total customers', t.customers], ['Completed', t.completed], ['Pending', t.pending], ['Authorized', KSh(t.authorized)], ['Paid', KSh(t.paid)], ['Remaining', KSh(t.balance)]].map(([k, x]) => <div className="card" key={k as string}><small>{k}</small><h3>{x}</h3></div>)}</div>
    {v && <div className="card" style={{ marginTop: 12 }}><b>Sandbox verification (all four required before going live)</b>
      {v.checks.map((c: any) => <div key={c.key}>{c.done ? '✅' : '⬜'} {c.label}</div>)}
      {v.allDone && <p><b>All checks passed.</b> You can now switch to production (see README).</p>}</div>}
    <h2>Groups</h2>
    <div className="grid">{d.groups.map((g: any) => <a className="card" key={g.id} href={'#/g/' + g.id}><b>{g.name}</b><h3>{g.count}/6</h3><small>customers<br />Paid {KSh(g.paid)}<br />Left {KSh(g.balance)}{g.pending ? <><br />{g.pending} pending</> : null}</small></a>)}</div>
  </>;
}

function Group({ id }: { id: number }) {
  const [d, setD] = useState<any>(null), [out, setOut] = useState<any[] | null>(null), [sum, setSum] = useState(''), [busy, setBusy] = useState(false);
  const load = useCallback(() => api('/groups/' + id).then(setD), [id]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { if (!d?.customers?.some((c: any) => c.status === 'Pending')) return; const t = setInterval(load, 10000); return () => clearInterval(t); }, [d, load]);
  const one = async (cid: number) => { setBusy(true); const r = await api('/stk-push', { customerId: cid }); setSum(''); setOut([r.customer ? r : { amount: 0, result: 'failed', detail: r.error || 'Failed' }]); setBusy(false); load(); };
  const all = async () => { setBusy(true); const r = await api('/stk-push-group', { groupId: id }); setSum(r.results ? `Sent: ${r.sent}   Failed: ${r.failed}   Skipped: ${r.skipped}` : ''); setOut(r.results || [{ amount: 0, result: 'failed', detail: r.error || 'Failed' }]); setBusy(false); load(); };
  if (!d) return <p>Loading…</p>; if (!d.customers) return <p className="err">{d.error}</p>;
  return <>
    <div className="row"><h2 style={{ margin: 0 }}>Group {id} <small>({d.customers.length}/6)</small></h2>
      <select value={id} onChange={e => (location.hash = '#/g/' + e.target.value)}>{Array.from({ length: 16 }, (_, i) => <option key={i} value={i + 1}>Group {i + 1}</option>)}</select>
      <button disabled={busy} onClick={all}>SEND PROMPTS TO GROUP</button></div>
    {sum && <p><b>{sum}</b></p>}{out && <Results rows={out} />}
    <div className="w"><table><thead><tr><th>Customer</th><th>Phone</th><th>Authorized</th><th>Paid</th><th>Balance</th><th>Next</th><th>Status</th><th></th></tr></thead><tbody>
      {d.customers.map((c: any) => <tr key={c.id}><td>{c.name}</td><td>{c.phone}</td><td>{KSh(c.authorized)}</td><td>{KSh(c.paid)}</td><td>{KSh(c.balance)}</td><td>{c.nextAmount ? KSh(c.nextAmount) : '-'}</td><td><Tag s={c.status} /></td>
        <td><button className="s" disabled={busy || !c.nextAmount || c.status === 'Pending'} onClick={() => one(c.id)}>SEND PROMPT</button></td></tr>)}
      {!d.customers.length && <tr><td colSpan={8}>No customers. Import a CSV.</td></tr>}</tbody></table></div>
  </>;
}

const SAMPLE = 'Group,Customer Name,M-Pesa Number,Authorized Total,Amount Already Paid\nGroup 1,Wanjiku Kamau,0712345678,1470,0\nGroup 1,Otieno Ochieng,0723456789,980,500\nGroup 2,Amina Hassan,0734567890,500,500\n';
function Import() {
  const [csv, setCsv] = useState(''), [r, setR] = useState<any>(null), [done, setDone] = useState(0);
  const pick = async (f?: File) => { if (!f) return; const t = await f.text(); setCsv(t); setDone(0); setR(await api('/import', { csv: t, dryRun: true })); };
  const sample = () => { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([SAMPLE], { type: 'text/csv' })); a.download = 'customer_template.csv'; a.click(); };
  const go = async () => { const x = await api('/import', { csv }); if (x.imported) { setDone(x.imported); setR(null); } else setR(x); };
  return <>
    <h2>Import Customers</h2>
    <div className="row"><input type="file" accept=".csv" onChange={e => pick(e.target.files?.[0])} /><button className="o" onClick={sample}>Download Sample CSV</button></div>
    <p><small>Max 6 customers per group. Nothing is imported if any row is invalid.</small></p>
    {done > 0 && <p>Imported {done} customers. <a href="#/">Dashboard</a></p>}
    {r && Object.entries(r.groups || {}).map(([g, i]: any) => <p key={g}><Tag s={i.ok ? 'VALID' : 'INVALID'} c={i.ok ? 'Ready' : 'Failed'} /> <b>Group {g}</b>: {i.rows} to import{i.existing ? ` (+${i.existing} existing)` : ''}</p>)}
    {r?.errors?.length > 0 && <ul className="err">{r.errors.map((e: string, i: number) => <li key={i}>{e}</li>)}</ul>}
    {r && !r.errors?.length && r.rows && <button onClick={go}>Import {r.rows.length} customers</button>}
    {r?.error && <p className="err">{r.error}</p>}
  </>;
}

function Pays() {
  const [d, setD] = useState<any[]>([]); useEffect(() => { api('/payments').then(x => setD(Array.isArray(x) ? x : [])); }, []);
  return <><h2>Payments</h2><div className="w"><table><thead><tr><th>Date</th><th>Customer</th><th>Grp</th><th>Amount</th><th>Status</th><th>Receipt</th><th>Code</th><th>Response</th><th>CheckoutRequestID</th></tr></thead><tbody>
    {d.map(p => <tr key={p.id}><td>{new Date(p.created_at).toLocaleString()}</td><td>{p.customer}</td><td>{p.group}</td><td>{KSh(p.amount)}</td><td><Tag s={p.status} c={p.status === 'completed' ? 'Ready' : p.status === 'pending' ? 'Pending' : 'Failed'} /></td><td>{p.receipt}</td><td>{p.result_code}</td><td>{p.result_desc}</td><td>{p.checkout_request_id}</td></tr>)}</tbody></table></div></>;
}
