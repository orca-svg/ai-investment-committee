// 샘플 데이터 생성기. 실제 시세가 아니라 시드 고정 난수로 만든 값이다.
// 실행: node scripts/gen-data.mjs  →  data/sample.json
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function mulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20261101);
const gauss = () => {
  const u = 1 - rand(), v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
};

// capTrn: 시가총액(조원, 샘플), target12m: 최근 12개월 누적수익률 목표
const assets = [
  { ticker: '005930', name: '삼성전자', sector: '반도체', capTrn: 380, pbr: 1.15, per: 14.2, roe: 8.1, div: 2.1, beta: 1.0, idio: 0.15, target12m: 0.06 },
  { ticker: '000660', name: 'SK하이닉스', sector: '반도체', capTrn: 140, pbr: 1.95, per: 7.8, roe: 24.5, div: 1.0, beta: 1.35, idio: 0.27, target12m: 0.48 },
  { ticker: '005380', name: '현대차', sector: '자동차', capTrn: 52, pbr: 0.58, per: 4.9, roe: 12.3, div: 5.2, beta: 0.9, idio: 0.19, target12m: 0.09 },
  { ticker: '105560', name: 'KB금융', sector: '금융', capTrn: 38, pbr: 0.52, per: 6.3, roe: 9.6, div: 4.8, beta: 0.8, idio: 0.17, target12m: 0.31 },
  { ticker: '035420', name: 'NAVER', sector: '인터넷', capTrn: 30, pbr: 1.32, per: 21.5, roe: 6.4, div: 0.6, beta: 1.1, idio: 0.25, target12m: -0.12 },
  { ticker: '068270', name: '셀트리온', sector: '바이오', capTrn: 42, pbr: 2.9, per: 58.0, roe: 4.9, div: 0.4, beta: 0.9, idio: 0.29, target12m: -0.04 },
  { ticker: '015760', name: '한국전력', sector: '유틸리티', capTrn: 16, pbr: 0.36, per: 12.0, roe: 3.1, div: 0.0, beta: 0.6, idio: 0.22, target12m: 0.22 },
];

const N_MONTHS = 36;
const months = [];
for (let i = 0; i < N_MONTHS; i++) {
  const d = new Date(Date.UTC(2023, 9 + i, 1)); // 2023-10 ~ 2026-09
  months.push(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`);
}
const market = months.map(() => 0.005 + 0.055 * gauss());

const cumulative = (rs) => rs.reduce((acc, r) => acc * (1 + r), 1) - 1;

for (const a of assets) {
  const r = market.map((m) => a.beta * m + (a.idio / Math.sqrt(12)) * gauss());
  // 최근 12개월 누적수익률이 target12m이 되도록 상수 이동(이분법)
  const last = r.slice(-12);
  let lo = -0.2, hi = 0.2;
  for (let k = 0; k < 80; k++) {
    const mid = (lo + hi) / 2;
    if (cumulative(last.map((x) => x + mid)) > a.target12m) hi = mid; else lo = mid;
  }
  const shift = (lo + hi) / 2;
  for (let i = N_MONTHS - 12; i < N_MONTHS; i++) r[i] += shift;
  a.returns = r.map((x) => Math.round(x * 1e5) / 1e5);
}

const totalCap = assets.reduce((s, a) => s + a.capTrn, 0);
const out = {
  note: '샘플 데이터 — 시드 고정 난수로 생성한 값이며 실제 시세·재무와 다릅니다.',
  months,
  assets: assets.map((a) => {
    const r = a.returns;
    const mean = r.reduce((s, x) => s + x, 0) / r.length;
    const sd = Math.sqrt(r.reduce((s, x) => s + (x - mean) ** 2, 0) / (r.length - 1));
    let peak = 1, nav = 1, mdd = 0;
    for (const x of r) { nav *= 1 + x; peak = Math.max(peak, nav); mdd = Math.min(mdd, nav / peak - 1); }
    const round1 = (x) => Math.round(x * 10) / 10;
    return {
      ticker: a.ticker, name: a.name, sector: a.sector, capTrn: a.capTrn,
      capWeight: a.capTrn / totalCap,
      pbr: a.pbr, per: a.per, roe: a.roe, div: a.div,
      ret12m: round1(cumulative(r.slice(-12)) * 100),
      ret3m: round1(cumulative(r.slice(-3)) * 100),
      vol: round1(sd * Math.sqrt(12) * 100),
      mdd: round1(mdd * 100),
      returns: r,
    };
  }),
};

fs.mkdirSync(path.join(root, 'data'), { recursive: true });
fs.writeFileSync(path.join(root, 'data/sample.json'), JSON.stringify(out, null, 1));
console.table(out.assets.map(({ returns, ...rest }) => ({ ...rest, capWeight: rest.capWeight.toFixed(3) })));
