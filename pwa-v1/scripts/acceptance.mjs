// Isolated accounting and guard checks. No browser storage or real ledger is read.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
const root = new URL('../', import.meta.url);
const source = readFileSync(new URL('src/app.js', root), 'utf8');
const html = readFileSync(new URL('index.html', root), 'utf8');
const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
assert.equal(new Set(ids).size, ids.length, 'unique HTML IDs');
for (const page of ['overview','records','analysis','settings','risk']) assert.ok(ids.includes('page-'+page),'navigation target '+page);
const importPage = html.slice(html.indexOf('id="page-overview"'),html.indexOf('id="page-records"'));
assert.ok(importPage.includes('home-import') && importPage.includes('home-camera'),'import and camera entry');
assert.ok(!importPage.includes('hero-total'),'old financial overview must not appear on import page');
assert.match(html, /<section hidden aria-hidden="true" id="compatibility-metrics">/);
for (const [, id] of source.matchAll(/\$\("#([^" ]+)"\)/g)) assert.ok(ids.includes(id), `missing ${id}`);
const context = vm.createContext({ document: { querySelector: () => ({}), querySelectorAll: () => [] }, Intl, Date, console, assert });
context.setupIntake = () => ({clear(){},cancel(){}});
vm.runInContext(source.slice(0, source.indexOf('forms.create.addEventListener')).replace(/^import .*;\r?\n/gm,''), context);
vm.runInContext(`
const today = localDateTimeInput();
const base = { id:'test', placedAt:today, settledAt:today, stakeMinor:10000, actualReturnMinor:18000, feeMinor:100, status:'won' };
assert.equal(wagerMetrics([base]).settledNet, 7900);
assert.equal(wagerMetrics([base]).roi, 79);
assert.equal(wagerMetrics([{...base,status:'void'}]).settledStake, 0);
assert.equal(wagerMetrics([{...base,status:'open',actualReturnMinor:null}]).openStake, 10000);
assert.equal(wagerMetrics([]).roi, null);
assert.equal(timeWindowIsSubset('09:00','17:00','10:00','16:00'), true);
assert.equal(timeWindowIsSubset('09:00','17:00','10:00','18:00'), false);
assert.equal(timeWindowIsSubset('22:00','04:00','23:00','03:00'), true);
assert.equal(amountInputMinor('12.345'), NaN);
assert.equal(amountInputMinor('0.01'), 1);
session = { state:{ wagers:[{...base,status:'open',actualReturnMinor:null}], records:[], riskSettings:{period:'monthly',budgetMinor:15000,lossLimitMinor:15000,maxStakeMinor:12000} } };
assert.ok(wagerBlockReasons({...base,status:'open',stakeMinor:16000},session.state.wagers[0]).length);
assert.equal(wagerBlockReasons({...base,status:'open',stakeMinor:5000},session.state.wagers[0]).length, 0);
assert.equal(wagerCashChangeBetween([base],localDateInput(),localDateInput()), 7900);
`, context);
console.log('Acceptance passed: HTML references, ROI, void/open accounting, money precision, time windows, edit guards, cash movement.');

