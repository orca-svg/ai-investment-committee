// 브라우저·서버·테스트가 함께 쓰는 순수 계산 모듈: 개념 판정 + Black-Litterman + 롱온리 최적화

export const METRICS = {
  pbr: { label: 'PBR', unit: '배' },
  per: { label: 'PER', unit: '배' },
  roe: { label: 'ROE', unit: '%' },
  div: { label: '배당수익률', unit: '%' },
  ret12m: { label: '12개월 수익률', unit: '%' },
  ret3m: { label: '3개월 수익률', unit: '%' },
  vol: { label: '연 변동성', unit: '%' },
  mdd: { label: '최대낙폭(3년)', unit: '%' },
};

export const OPS = {
  '<': '미만',
  '>': '초과',
  top: '상위 N개',
  bottom: '하위 N개',
};

export const TAU = 0.05;
export const MARKET_PREMIUM = 0.06; // 시장 포트폴리오 기대 초과수익 가정 → 위험회피계수 δ 역산

// ---------- 개념 정의 ----------

export function ruleText(rule) {
  const m = METRICS[rule.metric];
  if (rule.op === 'top') return `${m.label} 상위 ${rule.value}개`;
  if (rule.op === 'bottom') return `${m.label} 하위 ${rule.value}개`;
  return `${m.label} ${rule.value}${m.unit} ${OPS[rule.op]}`;
}

export function conceptText(concept) {
  const joiner = concept.combine === 'any' ? ' 또는 ' : ' 그리고 ';
  return `${concept.term} = ${concept.rules.map(ruleText).join(joiner)}`;
}

function matchRule(assets, rule) {
  const v = Number(rule.value);
  if (rule.op === '<') return new Set(assets.filter((a) => a[rule.metric] < v).map((a) => a.ticker));
  if (rule.op === '>') return new Set(assets.filter((a) => a[rule.metric] > v).map((a) => a.ticker));
  const sorted = [...assets].sort((a, b) => b[rule.metric] - a[rule.metric]);
  const n = Math.max(0, Math.round(v));
  if (n === 0) return new Set();
  const picked = rule.op === 'top' ? sorted.slice(0, n) : sorted.slice(-n);
  return new Set(picked.map((a) => a.ticker));
}

// 개념 정의를 결정론적으로 판정한다. LLM이 아니라 이 함수가 "누가 해당하는가"를 정한다.
export function matchConcept(assets, concept) {
  if (!concept.rules.length) return [];
  const sets = concept.rules.map((r) => matchRule(assets, r));
  return assets.map((a) => a.ticker).filter((t) =>
    concept.combine === 'any' ? sets.some((s) => s.has(t)) : sets.every((s) => s.has(t)),
  );
}

// ---------- 선형대수 (자산 수가 작으므로 단순 구현) ----------

const matVec = (A, x) => A.map((row) => row.reduce((s, a, j) => s + a * x[j], 0));
const dot = (a, b) => a.reduce((s, x, i) => s + x * b[i], 0);

function invert(M) {
  const n = M.length;
  const A = M.map((row, i) => [...row, ...row.map((_, j) => (i === j ? 1 : 0))]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    const d = A[c][c];
    for (let j = 0; j < 2 * n; j++) A[c][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c];
      for (let j = 0; j < 2 * n; j++) A[r][j] -= f * A[c][j];
    }
  }
  return A.map((row) => row.slice(n));
}

export function covarianceAnnual(assets) {
  const R = assets.map((a) => a.returns);
  const T = R[0].length;
  const means = R.map((r) => r.reduce((s, x) => s + x, 0) / T);
  return R.map((ri, i) => R.map((rj, j) => {
    let s = 0;
    for (let t = 0; t < T; t++) s += (ri[t] - means[i]) * (rj[t] - means[j]);
    return (s / (T - 1)) * 12;
  }));
}

// 시장 균형: δ = 시장 초과수익 가정 / 시장 분산, π = δ Σ w_mkt
export function equilibrium(assets) {
  const Sigma = covarianceAnnual(assets);
  const wMkt = assets.map((a) => a.capWeight);
  const varMkt = dot(wMkt, matVec(Sigma, wMkt));
  const delta = MARKET_PREMIUM / varMkt;
  const pi = matVec(Sigma, wMkt).map((x) => delta * x);
  return { Sigma, wMkt, delta, pi };
}

// views: [{ asset: index, q: 균형 기대수익 대비 초과(소수), c: 유효 확신도 0~1, agentId }]
// 견해 행 p = e_i, Q = π_i + q (시장이 이미 반영한 기대수익보다 q만큼 더 오른다) → Q − Pπ = q
// Ω_kk = τ pΣpᵀ · (1−c)/c  (Idzorek식 확신도 → 불확실성 변환)
// μ = π + τΣPᵀ(PτΣPᵀ+Ω)⁻¹(Q − Pπ). 이 식은 (Q − Pπ)에 선형이라 견해별 기여가 정확히 더해진다.
export function blackLitterman({ Sigma, pi }, views) {
  const n = pi.length;
  const active = views.filter((v) => v.c > 0);
  if (!active.length) return { mu: [...pi], viewContrib: [] };
  const P = active.map((v) => pi.map((_, i) => (i === v.asset ? 1 : 0)));
  const tS = Sigma.map((row) => row.map((x) => TAU * x));
  const tSPt = P.map((p) => matVec(tS, p)); // K × n (각 행 = τΣpₖ)
  const A = P.map((pa) => P.map((_, b) => dot(pa, tSPt[b])));
  active.forEach((v, k) => {
    const c = Math.min(v.c, 0.99);
    A[k][k] += A[k][k] * (1 - c) / c;
  });
  const Ainv = invert(A);
  const gap = active.map((v) => v.q);
  const viewContrib = active.map((v, j) => {
    const vec = Array(n).fill(0);
    for (let k = 0; k < active.length; k++) {
      const coef = Ainv[k][j] * gap[j];
      for (let i = 0; i < n; i++) vec[i] += tSPt[k][i] * coef;
    }
    return { ...v, vec };
  });
  const mu = pi.map((p, i) => p + viewContrib.reduce((s, vc) => s + vc.vec[i], 0));
  return { mu, viewContrib };
}

function projectSimplex(v) {
  const u = [...v].sort((a, b) => b - a);
  let css = 0, theta = 0;
  for (let i = 0; i < u.length; i++) {
    css += u[i];
    const t = (css - 1) / (i + 1);
    if (u[i] - t > 0) theta = t;
  }
  return v.map((x) => Math.max(x - theta, 0));
}

// max wᵀμ − δ/2 wᵀΣw  s.t. w ≥ 0, Σw = 1  (투영 경사상승)
export function optimizeLongOnly(mu, Sigma, delta, w0) {
  let lmax = 0, x = mu.map(() => 1);
  for (let k = 0; k < 50; k++) {
    const y = matVec(Sigma, x);
    lmax = Math.sqrt(dot(y, y));
    x = y.map((v) => v / lmax);
  }
  const step = 1 / (delta * lmax);
  let w = [...w0];
  for (let it = 0; it < 3000; it++) {
    const g = matVec(Sigma, w).map((s, i) => mu[i] - delta * s);
    w = projectSimplex(w.map((wi, i) => wi + step * g[i]));
  }
  return w;
}

// 위원회 전체 계산: 견해 수집 → BL → 최적화 → 에이전트별 기여
// agents: [{ id, trust(0~1) }], viewsByAgent: { [id]: [{ ticker, excessReturnPct, confidence }] }
export function computeCommittee(assets, agents, viewsByAgent) {
  const eq = equilibrium(assets);
  const idx = Object.fromEntries(assets.map((a, i) => [a.ticker, i]));
  const views = [];
  for (const ag of agents) {
    for (const v of viewsByAgent[ag.id] || []) {
      if (!(v.ticker in idx)) continue;
      views.push({
        agentId: ag.id, ticker: v.ticker, asset: idx[v.ticker],
        q: v.excessReturnPct / 100, cAgent: v.confidence, trust: ag.trust,
        c: v.confidence * ag.trust,
      });
    }
  }
  const { mu, viewContrib } = blackLitterman(eq, views);
  const w = optimizeLongOnly(mu, eq.Sigma, eq.delta, eq.wMkt);
  const byAgent = Object.fromEntries(agents.map((ag) => [ag.id, assets.map(() => 0)]));
  for (const vc of viewContrib) vc.vec.forEach((x, i) => { byAgent[vc.agentId][i] += x; });
  const absOf = (id) => byAgent[id].reduce((t, x) => t + Math.abs(x), 0);
  const absTotal = agents.reduce((s, ag) => s + absOf(ag.id), 0);
  const influence = Object.fromEntries(agents.map((ag) => [ag.id, absTotal ? absOf(ag.id) / absTotal : 0]));
  return { ...eq, mu, w, views, viewContrib, byAgent, influence };
}
