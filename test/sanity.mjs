// BL sanity check: 견해가 없으면(또는 신뢰도가 모두 0이면) 사후 기대수익 = 균형 수익률, 비중 = 시장 비중
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { computeCommittee } from '../public/core.js';

const data = JSON.parse(fs.readFileSync(new URL('../data/sample.json', import.meta.url)));
const agents = [{ id: 'value', trust: 0.5 }, { id: 'momentum', trust: 0.5 }];
const maxDiff = (a, b) => Math.max(...a.map((x, i) => Math.abs(x - b[i])));

const none = computeCommittee(data.assets, agents, {});
assert.ok(maxDiff(none.mu, none.pi) < 1e-12, 'no views: μ must equal π');
assert.ok(maxDiff(none.w, none.wMkt) < 1e-6, 'no views: w must equal w_mkt');

const views = { value: [{ ticker: '005380', excessReturnPct: 4, confidence: 0.7 }] };
const zeroTrust = computeCommittee(data.assets, agents.map((a) => ({ ...a, trust: 0 })), views);
assert.ok(maxDiff(zeroTrust.mu, zeroTrust.pi) < 1e-12, 'zero trust: μ must equal π');

const withView = computeCommittee(data.assets, agents, views);
const sum = withView.w.reduce((s, x) => s + x, 0);
assert.ok(Math.abs(sum - 1) < 1e-9 && withView.w.every((x) => x >= 0), 'long-only, Σw = 1');
const i = data.assets.findIndex((a) => a.ticker === '005380');
assert.ok(withView.w[i] > withView.wMkt[i], 'positive view must raise the weight');
const contribSum = withView.pi.map((p, k) => p + withView.byAgent.value[k] + withView.byAgent.momentum[k]);
assert.ok(maxDiff(contribSum, withView.mu) < 1e-12, 'agent contributions must add up to μ − π');

console.log('BL sanity check 통과: 견해 없음 → μ = π, w = w_mkt (max |μ−π| =', maxDiff(none.mu, none.pi).toExponential(1) + ')');
