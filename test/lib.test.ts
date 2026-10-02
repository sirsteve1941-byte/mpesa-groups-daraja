import * as L from '../src/lib'; import a from 'assert';
type C = { authorized: number; paid: number; cycle_step: number };
const c = (authorized: number, paid: number, cycle_step = 0): C => ({ authorized, paid, cycle_step });
// simulate successful payments until completion
const walk = (x: C) => { const o: number[] = []; for (let i = 0; i < 20 && L.nextAmount(x) > 0; i++) { const n = L.nextAmount(x); o.push(n); x.paid += n; x.cycle_step++; } return o; };
a.deepStrictEqual(walk(c(1470, 0)), [500, 490, 480]);
a.deepStrictEqual(walk(c(980, 500, 1)), [480]);
a.deepStrictEqual(walk(c(520, 0)), [500, 20]);
a.deepStrictEqual(walk(c(250, 0)), [250]);
a.deepStrictEqual(walk(c(500, 500, 1)), []);
a.deepStrictEqual(walk(c(3000, 0)), [500, 490, 480, 500, 490, 480, 60]);
// independent cycles: same group, different positions
const g = [c(1470, 0), c(1470, 500, 1), c(1470, 990, 2)];
a.deepStrictEqual(g.map(L.nextAmount), [500, 490, 480]);
a.strictEqual(L.stepFromPaid(990), 2); a.strictEqual(L.stepFromPaid(0), 0); a.strictEqual(L.stepFromPaid(1470), 3);
for (const [i, o] of [['0712345678', '254712345678'], ['0112345678', '254112345678'], ['254712345678', '254712345678'], ['254112345678', '254112345678'], ['+254 712-345-678', '254712345678']]) a.strictEqual(L.normPhone(i), o);
for (const bad of ['0612345678', '071234567', '25471234567', 'abc', '', null]) a.strictEqual(L.normPhone(bad as any), null);
a.ok(L.accountRef('Wanjiku Kamau-Njeri Ltd').length <= 12); a.strictEqual(L.accountRef('!!!'), 'Payment'); a.strictEqual(L.accountRef('Zoë Ünal'), 'Zoe Unal');
const H = 'Group,Customer Name,M-Pesa Number,Authorized Total,Amount Already Paid';
const v = (...r: string[]) => L.validateCsv([H, ...r].join('\n'));
a.strictEqual(v('Group 1,A,0712345678,1470,0', 'Group 1,B,0723456789,980,500', 'Group 2,C,0734567890,500,500').errors.length, 0);
a.ok(L.validateCsv('Name,Phone\nx,y').errors[0].includes('Header must be exactly'));
a.ok(v(...Array.from({ length: 8 }, (_, i) => `Group 2,C${i},07123456${10 + i},500,0`)).errors.includes('Group 2 contains 8 customers. Maximum allowed is 6.'));
a.strictEqual(v(...Array.from({ length: 6 }, (_, i) => `Group 3,C${i},07123456${10 + i},500,0`)).errors.length, 0);
a.ok(L.validateCsv([H, 'Group 1,A,0712345678,500,0'].join('\n'), { 1: ['254712345670', '254712345671', '254712345672', '254712345673', '254712345674', '254712345675'] }).errors.some(e => e.includes('contains 7')));
for (const [row, msg] of [['Group 17,A,0712345678,500,0', 'invalid group'], ['Group 1,A,0612345678,500,0', 'invalid M-Pesa'], ['Group 1,A,0712345678,-5,0', 'Authorized'], ['Group 1,A,0712345678,500,-1', 'Amount Already Paid'],
  ['Group 1,A,0712345678,500,600', 'exceeds'], ['Group 1,,0712345678,500,0', 'missing customer name'], ['Group 1,A,0712345678,500', 'expected 5 columns'], ['Group 1,A,0712345678,5e2,0', 'Authorized']]) a.ok(v(row).errors.some(e => e.includes(msg)), row);
a.ok(v('Group 1,A,0712345678,500,0', 'Group 1,B,254712345678,500,0').errors.some(e => e.includes('duplicate')));
a.strictEqual(v('Group 1,"Doe, John",0712345678,500,0').rows[0].name, 'Doe, John');
console.log('lib ok');
