const CYCLE = [500, 490, 480];
const normPhone = p => { const m = String(p || '').replace(/[\s+\-]/g, '').match(/^(?:0|254)([71]\d{8})$/); return m ? '254' + m[1] : null; };
const balance = c => Math.max(0, c.authorized - c.paid);
const nextAmount = c => { const r = balance(c); return r <= 0 ? 0 : Math.min(CYCLE[c.cycle_step % 3], r); };
const stepFromPaid = p => { let s = 0; while (p >= CYCLE[s % 3]) { p -= CYCLE[s % 3]; s++; } return s; };
const accountRef = n => String(n || '').normalize('NFKD').replace(/[^A-Za-z0-9 ]/g, '').trim().replace(/\s+/g, ' ').slice(0, 12) || 'Payment';
const splitLine = l => { const o = []; let c = '', q = false; for (const ch of l) { if (ch === '"') q = !q; else if (ch === ',' && !q) { o.push(c); c = ''; } else c += ch; } o.push(c); return o.map(s => s.trim()); };
const HEADER = ['Group', 'Customer Name', 'M-Pesa Number', 'Authorized Total', 'Amount Already Paid'];

function validateCsv(text, existing: Record<string, string[]> = {}) {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter(l => l.trim());
  if (!lines.length) return { errors: ['CSV is empty'], groups: {}, rows: [] };
  if (splitLine(lines[0]).join('|') !== HEADER.join('|')) return { errors: ['Header must be exactly: ' + HEADER.join(',')], groups: {}, rows: [] };
  const errors: string[] = [], rows: any[] = [], counts: Record<string, number> = {}, seen = new Set<string>();
  lines.slice(1).forEach((l, i) => {
    const n = i + 2, f = splitLine(l);
    if (f.length !== 5) return errors.push(`Row ${n}: expected 5 columns, found ${f.length}`);
    const g = f[0].match(/^group\s*(\d+)$/i), grp = g ? +g[1] : 0, phone = normPhone(f[2]), a = /^\d+$/.test(f[3]) ? Number(f[3]) : NaN, p = /^\d+$/.test(f[4]) ? Number(f[4]) : NaN;
    if (!grp || grp > 16) errors.push(`Row ${n}: invalid group "${f[0]}" (use Group 1 to Group 16)`);
    if (!f[1]) errors.push(`Row ${n}: missing customer name`);
    if (!phone) errors.push(`Row ${n}: invalid M-Pesa number "${f[2]}"`);
    if (!Number.isInteger(a) || a <= 0) errors.push(`Row ${n}: Authorized Total must be a positive whole number`);
    if (!Number.isInteger(p) || p < 0) errors.push(`Row ${n}: Amount Already Paid must be a whole number, zero or more`);
    else if (Number.isInteger(a) && p > a) errors.push(`Row ${n}: Amount Already Paid (${p}) exceeds Authorized Total (${a})`);
    const key = grp + '|' + phone;
    if (phone && (seen.has(key) || (existing[grp] || []).includes(phone))) errors.push(`Row ${n}: duplicate customer ${phone} in Group ${grp}`);
    seen.add(key);
    counts[grp] = (counts[grp] || 0) + 1;
    rows.push({ grp, name: f[1].slice(0, 80), phone, a, p });
  });
  const groups: Record<string, any> = {};
  for (const g of Object.keys(counts)) {
    const total = counts[g] + (existing[g] || []).length;
    groups[g] = { rows: counts[g], existing: (existing[g] || []).length, total, ok: total <= 6 };
    if (total > 6) errors.push(`Group ${g} contains ${total} customers. Maximum allowed is 6.`);
  }
  return { errors, groups, rows };
}
export { CYCLE, normPhone, balance, nextAmount, stepFromPaid, accountRef, validateCsv };
