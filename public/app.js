import { API_BASE } from './api.js';
import { METRICS, OPS, matchConcept, conceptText, ruleText, computeCommittee } from './core.js';

const DEFAULT_AGENTS = [
  {
    id: 'value', name: '가치 위원', initial: '가', color: '#5e5ce6', tagline: '싸게 사서 제값 받을 때까지 기다린다',
    stance: '장부가치·이익 대비 저평가된 종목은 결국 제 가치를 찾아간다고 믿는다. 비싼 종목은 경계한다.',
    direction: 1, trust: 0.5,
    concept: { term: '가치주', combine: 'all', rules: [{ metric: 'pbr', op: '<', value: 1 }, { metric: 'roe', op: '>', value: 8 }] },
  },
  {
    id: 'momentum', name: '모멘텀 위원', initial: '모', color: '#e8780c', tagline: '오르는 종목이 더 오른다',
    stance: '최근 강하게 오른 종목은 추세가 이어진다고 본다. 가격이 정보를 먼저 반영한다고 믿는다.',
    direction: 1, trust: 0.5,
    concept: { term: '상승 추세주', combine: 'all', rules: [{ metric: 'ret12m', op: 'top', value: 2 }] },
  },
  {
    id: 'risk', name: '리스크관리 위원', initial: '리', color: '#1d9bb0', tagline: '잃지 않는 것이 먼저다',
    stance: '변동성이 크거나 낙폭이 깊었던 종목은 기대수익보다 위험이 크다고 본다.',
    direction: -1, trust: 0.5,
    concept: { term: '고위험주', combine: 'any', rules: [{ metric: 'vol', op: '>', value: 32 }, { metric: 'mdd', op: '<', value: -35 }] },
  },
];

// 지표를 쓰는 자리마다 함께 보여 줄 쉬운 설명
const HELP = {
  pbr: '주가 ÷ 1주당 순자산. 1배 미만이면 장부상 가치보다 싸게 거래된다는 뜻',
  per: '주가 ÷ 1주당 순이익. 낮을수록 버는 돈에 비해 싸다',
  roe: '자기자본으로 1년에 몇 % 이익을 냈는지. 높을수록 돈을 잘 번다',
  div: '주가 대비 1년 배당금 비율',
  ret12m: '최근 12개월 동안 주가가 오른 비율',
  ret3m: '최근 3개월 동안 주가가 오른 비율',
  vol: '주가가 1년에 얼마나 출렁이는지. 클수록 위험하다',
  mdd: '최근 3년 중 고점 대비 가장 크게 떨어진 폭',
};
const CAPITAL = 100_000_000; // 모의 계좌 1억원
const LS_LOG = 'committee-log-v1';
const LS_HOLD = 'committee-holdings-v1';

const $ = (s) => document.querySelector(s);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pct = (x, d = 1) => `${(x * 100).toFixed(d)}%`;
const pp = (x, d = 1) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${Math.abs(x * 100).toFixed(d)}%p`;
const sign = (x) => (x > 0.0005 ? 'pos' : x < -0.0005 ? 'neg' : '');
const won = (x) => `${Math.round(x / 10000).toLocaleString('ko-KR')}만원`;
const store = {
  get(k, f) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : f; } catch { return f; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};

const state = {
  assets: [], mode: 'offline', model: null,
  agents: structuredClone(DEFAULT_AGENTS),
  res: {},          // 위원별 최근 의견 요청 결과
  editing: {},      // 위원별 기준 초안 { concept, direction }
  whyOpen: new Set(),
  calc: null, zero: null, holdings: null, log: [],
};
const agentOf = (id) => state.agents.find((a) => a.id === id);
const nameOf = (t) => state.assets.find((a) => a.ticker === t)?.name ?? t;
const cardOf = (id) => document.querySelector(`.agent[data-id="${id}"]`);
const doneAgents = () => state.agents.filter((a) => state.res[a.id]?.status === 'done');
const anyLoading = () => state.agents.some((a) => state.res[a.id]?.status === 'loading');

function setOpen(collapsible, toggle, open) {
  collapsible.classList.toggle('open', open);
  collapsible.inert = !open;
  if (toggle) toggle.setAttribute('aria-expanded', String(open));
}

// ---------- 위원 카드 ----------

function criteriaHTML(ag) {
  const joiner = ag.concept.combine === 'any' ? ' 또는 ' : ' · ';
  const rules = ag.concept.rules.map((r) => `<span class="term" title="${esc(HELP[r.metric])}">${esc(ruleText(r))}</span>`).join(joiner);
  return `<p class="criteria">‘<b>${esc(ag.concept.term)}</b>’의 기준 — ${rules || '없음'}</p>`;
}

function opinionHTML(ag) {
  const r = state.res[ag.id];
  if (!r) return '<p class="empty">아직 의견이 없어요.</p>';
  if (r.status === 'loading') {
    return `<div class="loading"><span class="spinner"></span>${state.mode === 'gemini' ? '데이터를 읽고 의견을 정리하는 중' : '기준으로 의견을 만드는 중'}… <span data-elapsed="${r.startedAt}">0.0초</span></div>`;
  }
  if (r.status === 'error') {
    return `<p class="error">의견을 받지 못했어요. ${esc(r.error)}</p><button class="btn tinted small" data-act="retry">다시 묻기</button>`;
  }
  if (!r.views.length) return '<p class="empty">이번엔 기준에 맞는 종목이 없어 의견을 내지 않았어요.</p>';
  const open = state.whyOpen.has(ag.id);
  return `
    <div class="claims">${r.views.map((v) => `
      <span class="claim ${v.excessReturnPct > 0 ? 'pos' : 'neg'}" title="시장 예상보다 ${pp(v.excessReturnPct / 100)} · 자신감 ${pct(v.confidence, 0)}">
        ${v.excessReturnPct > 0 ? '↑' : '↓'} ${esc(nameOf(v.ticker))}</span>`).join('')}
      <button class="disclose" data-act="why" aria-expanded="${open}">근거</button>
    </div>
    <div class="collapsible ${open ? 'open' : ''}" data-why ${open ? '' : 'inert'}><div>
      <ul class="why-list">${r.views.map((v) => `
        <li><div class="why-head"><b>${esc(nameOf(v.ticker))}</b>
          <span class="${v.excessReturnPct > 0 ? 'pos' : 'neg'}">시장 예상보다 ${pp(v.excessReturnPct / 100)}</span>
          <span class="muted">자신감 ${pct(v.confidence, 0)}</span></div>
          <p>${esc(v.rationale)}</p></li>`).join('')}
      </ul>
      <details class="prompt"><summary>이 위원에게 보낸 지시문 보기 · ${r.source === 'offline-rules' ? '오프라인 규칙' : esc(r.source)} · ${(r.latencyMs / 1000).toFixed(1)}초</summary>
        <pre>${esc(r.prompt)}</pre></details>
    </div></div>`;
}

function editorHTML(ag) {
  const d = state.editing[ag.id];
  const opt = (obj, cur) => Object.entries(obj).map(([k, v]) => `<option value="${k}" ${k === String(cur) ? 'selected' : ''}>${esc(v.label ?? v)}</option>`).join('');
  return `
    <div class="editor">
      <p class="editor-title">‘<input data-f="term" value="${esc(d.concept.term)}" aria-label="용어">’라고 부를 기준</p>
      ${d.concept.rules.map((r, i) => `
        <div class="rule" data-rule="${i}">
          <select data-f="metric" aria-label="지표">${opt(METRICS, r.metric)}</select>
          <input type="number" step="any" data-f="value" value="${r.value}" aria-label="값">
          <select data-f="op" aria-label="조건">${opt(OPS, r.op)}</select>
          <button class="icon-btn" data-act="del-rule" aria-label="이 조건 삭제" title="이 조건 삭제">×</button>
          <p class="rule-help">${esc(HELP[r.metric])}</p>
        </div>`).join('')}
      <div><button class="btn plain" data-act="add-rule">+ 조건 추가</button></div>
      <details class="advanced"><summary>더 보기</summary>
        <label>여러 조건은 <select data-f="combine">${opt({ all: '모두 만족해야', any: '하나만 만족해도' }, d.concept.combine)}</select> 해당</label>
        <label>해당 종목을 <select data-f="direction">${opt({ 1: '좋게 본다 (비중 ↑)', '-1': '나쁘게 본다 (비중 ↓)' }, d.direction)}</select></label>
      </details>
      <div class="preview" data-preview></div>
      <div class="editor-actions">
        <button class="btn tinted small" data-act="cancel">취소</button>
        <button class="btn primary small" data-act="commit">이 기준으로 다시 묻기</button>
      </div>
    </div>`;
}

function renderCard(id) {
  const ag = agentOf(id);
  const done = state.res[id]?.status === 'done';
  const editing = Boolean(state.editing[id]);
  cardOf(id).innerHTML = `
    <div class="agent-head">
      <span class="avatar">${ag.initial}</span>
      <div class="who"><h3>${esc(ag.name)}</h3><p>${esc(ag.tagline)}</p></div>
      ${editing ? '' : '<button class="btn plain" data-act="edit">기준 바꾸기</button>'}
    </div>
    ${editing ? editorHTML(ag) : criteriaHTML(ag)}
    <div data-opinion>${opinionHTML(ag)}</div>
    <div class="trust">
      <div class="trust-row"><label for="trust-${id}">얼마나 믿을까요?</label><span class="trust-word" data-trust-word></span></div>
      <input id="trust-${id}" type="range" min="0" max="100" step="5" value="${Math.round(ag.trust * 100)}" data-trust ${done ? '' : 'disabled'}>
      <p class="influence" data-influence></p>
    </div>`;
  if (editing) updatePreview(id);
  updateTrustText(id);
}

function renderAgents() {
  $('#agents').innerHTML = state.agents.map((ag) => `<article class="agent" data-id="${ag.id}" style="--c:${ag.color}"></article>`).join('');
  state.agents.forEach((ag) => renderCard(ag.id));
}

const trustWord = (t) => (t === 0 ? '무시' : t <= 0.3 ? '조금' : t <= 0.65 ? '보통' : t < 1 ? '많이' : '전적으로');

function updateTrustText(id) {
  const ag = agentOf(id);
  const card = cardOf(id);
  card.querySelector('[data-trust-word]').textContent = `${trustWord(ag.trust)} · ${Math.round(ag.trust * 100)}%`;
  const has = state.calc?.views.some((v) => v.agentId === id);
  card.querySelector('[data-influence]').innerHTML = !has
    ? '의견이 도착하면 믿음 정도를 정할 수 있어요.'
    : ag.trust === 0 ? '이번 결정에 반영되지 않아요.'
      : `이번 결정에 미친 영향 <b>${pct(state.calc.influence[id], 0)}</b>`;
}

// 초안 기준을 즉시 판정해 현재 기준과 비교해 보여 준다
function readDraft(id) {
  const box = cardOf(id).querySelector('.editor');
  const d = state.editing[id];
  d.concept = {
    term: box.querySelector('[data-f="term"]').value.trim() || '개념',
    combine: box.querySelector('[data-f="combine"]').value,
    rules: [...box.querySelectorAll('[data-rule]')].map((row) => ({
      metric: row.querySelector('[data-f="metric"]').value,
      op: row.querySelector('[data-f="op"]').value,
      value: Number(row.querySelector('[data-f="value"]').value),
    })),
  };
  d.direction = Number(box.querySelector('[data-f="direction"]').value);
}

function updatePreview(id) {
  const ag = agentOf(id);
  const d = state.editing[id];
  const before = new Set(matchConcept(state.assets, ag.concept));
  const after = matchConcept(state.assets, d.concept);
  const removed = [...before].filter((t) => !after.includes(t));
  const chips = [
    ...after.map((t) => `<span class="chip ${before.has(t) ? '' : 'added'}">${before.has(t) ? '' : '+ '}${esc(nameOf(t))}</span>`),
    ...removed.map((t) => `<span class="chip removed">${esc(nameOf(t))}</span>`),
  ].join('');
  const card = cardOf(id);
  card.querySelector('[data-preview]').innerHTML =
    `이 기준에 맞는 종목 <small>(AI가 아니라 코드가 판정)</small><br>${chips || '<span class="chip removed">없음</span>'}`;
  const changed = JSON.stringify({ c: d.concept, d: d.direction }) !== JSON.stringify({ c: ag.concept, d: ag.direction });
  card.querySelector('[data-act="commit"]').disabled = !changed;
}

async function requestView(id) {
  const ag = agentOf(id);
  const req = { status: 'loading', startedAt: Date.now(), conceptText: conceptText(ag.concept) };
  state.res[id] = req;
  renderCard(id);
  recompute();
  try {
    const res = await fetch(`${API_BASE}/api/agent-view`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ agent: { id, name: ag.name, stance: ag.stance, direction: ag.direction, concept: ag.concept } }),
    });
    const json = await res.json();
    if (!res.ok) throw new Error(json.error || `HTTP ${res.status}`);
    Object.assign(req, json, { status: 'done' });
  } catch (e) {
    Object.assign(req, { status: 'error', error: e.message });
  }
  if (state.res[id] !== req) return; // 더 최근 요청이 있으면 버린다
  renderCard(id);
  recompute();
}

// ---------- 포트폴리오 ----------

function recompute() {
  const viewsByAgent = {};
  for (const ag of doneAgents()) viewsByAgent[ag.id] = state.res[ag.id].views;
  state.calc = computeCommittee(state.assets, state.agents.map((a) => ({ id: a.id, trust: a.trust })), viewsByAgent);
  state.zero = computeCommittee(state.assets, state.agents.map((a) => ({ id: a.id, trust: 0 })), viewsByAgent);
  state.agents.forEach((ag) => updateTrustText(ag.id));
  updatePortfolio();
  renderContrib();
  renderDecision();
  renderSteps();
}

function buildPortfolioRows() {
  $('#pf-rows').innerHTML = state.assets.map((a) => `
    <div class="prow" data-ticker="${a.ticker}">
      <span class="pname">${esc(a.name)}</span>
      <span class="ptrack"><span class="pfill"></span><span class="pmarker" title="시장 비중"></span></span>
      <span class="pval"></span><span class="pdelta"></span>
    </div>`).join('');
}

// DOM을 다시 만들지 않고 값만 바꿔서, 막대가 현재 위치에서 새 위치로 이어서 움직이게 한다
function updatePortfolio() {
  const c = state.calc;
  const maxW = Math.max(...c.wMkt, ...c.w);
  state.assets.forEach((a, i) => {
    const row = document.querySelector(`.prow[data-ticker="${a.ticker}"]`);
    const d = c.w[i] - c.wMkt[i];
    row.querySelector('.pfill').style.transform = `scaleX(${c.w[i] / maxW})`;
    row.querySelector('.pmarker').style.left = `${(c.wMkt[i] / maxW) * 100}%`;
    row.querySelector('.pval').textContent = pct(c.w[i]);
    const delta = row.querySelector('.pdelta');
    delta.textContent = Math.abs(d) >= 0.0005 ? pp(d) : '';
    delta.className = `pdelta ${sign(d)}`;
  });
  const has = c.views.length > 0;
  $('#pf-status').textContent = anyLoading() && !has ? '위원 의견을 기다리는 중이에요.'
    : has ? '위원 의견을 믿는 만큼 반영해 시장 비중에서 조정했어요.'
      : '아직 의견이 없어 시장 비중(시가총액 순) 그대로예요.';
  const vol = (w) => Math.sqrt(w.reduce((s, wi, i) => s + wi * c.Sigma[i].reduce((t, x, j) => t + x * w[j], 0), 0));
  $('#pf-kpi').textContent = has ? `예상 변동성 ${pct(vol(c.wMkt))} → ${pct(vol(c.w))}` : '';
  $('#contrib-toggle').hidden = !has;
  if (!has) setOpen($('#contrib'), $('#contrib-toggle'), false);
}

function renderContrib() {
  const c = state.calc;
  if (!c.views.length) { $('#contrib-body').innerHTML = ''; return; }
  const pos = state.assets.map((_, i) => state.agents.reduce((s, ag) => s + Math.max(0, c.byAgent[ag.id][i]), 0));
  const neg = state.assets.map((_, i) => state.agents.reduce((s, ag) => s + Math.max(0, -c.byAgent[ag.id][i]), 0));
  const scale = Math.max(0.005, ...pos, ...neg);
  const bars = (i) => {
    let up = 0, down = 0;
    return state.agents.map((ag) => {
      const x = c.byAgent[ag.id][i];
      if (Math.abs(x) < 1e-6) return '';
      const width = (Math.abs(x) / scale) * 50;
      const left = x > 0 ? 50 + up : 50 - down - width;
      if (x > 0) up += width; else down += width;
      return `<span style="left:${left}%;width:${width}%;background:${ag.color}" title="${esc(ag.name)}: 기대수익 ${pp(x, 2)}"></span>`;
    }).join('');
  };
  $('#contrib-body').innerHTML = `
    <p class="hint">각 위원이 종목별 기대수익을 얼마나 올리고(→) 내렸는지(←)입니다. 믿음 정도를 바꾸면 막대 길이가 바뀝니다.</p>
    ${state.assets.map((a, i) => `<div class="contrib-row"><span class="pname">${esc(a.name)}</span><div class="div-bar">${bars(i)}</div></div>`).join('')}
    <div class="contrib-legend">${state.agents.map((ag) => `<span><i style="background:${ag.color}"></i>${esc(ag.name)}</span>`).join('')}</div>
    <p style="margin-top:12px"><button class="btn plain" data-sheet="process">결정 과정 전체 보기 (수식 포함) ›</button></p>`;
}

// ---------- 승인 · 반려 ----------

function pendingTrades() {
  return state.assets
    .map((a, i) => ({ name: a.name, from: state.holdings[i], to: state.calc.w[i] }))
    .filter((t) => Math.abs(t.to - t.from) >= 0.001);
}

function renderDecision() {
  const trades = pendingTrades();
  let reason = '';
  if (!doneAgents().length) reason = '먼저 위원 의견을 들어 주세요.';
  else if (anyLoading()) reason = '위원 의견을 기다리는 중이에요.';
  else if (!trades.length) reason = '이미 이 비중으로 승인했어요.';
  $('#approve').disabled = Boolean(reason);
  $('#approve-reason').textContent = reason;
  const buys = trades.filter((t) => t.to > t.from).length;
  $('#trades-toggle').hidden = Boolean(reason);
  $('#trades-toggle').textContent = `매매 미리보기 · 매수 ${buys}건, 매도 ${trades.length - buys}건`;
  if (reason) setOpen($('#trades'), $('#trades-toggle'), false);
  $('#trade-list').innerHTML = trades.map((t) => `<li><span>${esc(t.name)} ${pct(t.from)} → ${pct(t.to)}</span>
    <span class="${sign(t.to - t.from)}">${t.to > t.from ? '매수' : '매도'} ${won(Math.abs(t.to - t.from) * CAPITAL)}</span></li>`).join('');
  $('#reject-open').hidden = !doneAgents().length;
  $('#reject').disabled = !$('#reject-text').value.trim();
}

function renderSteps() {
  const lis = [...document.querySelectorAll('#steps li')];
  const has = doneAgents().length > 0;
  const approved = has && state.log[0]?.type === 'approve' && !pendingTrades().length;
  const current = !has ? 0 : approved ? 3 : 1;
  lis.forEach((li, i) => {
    li.className = i < current || (approved && i === 2) ? 'done' : i === current ? 'current' : '';
  });
  $('#log-btn').textContent = state.log.length ? `기록 ${state.log.length}` : '기록';
}

let toastTimer;
function toast(html) {
  const el = $('#toast');
  el.innerHTML = html;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

function trustSnapshot() {
  return state.agents.map((a) => `${a.name} ${Math.round(a.trust * 100)}%`).join(' · ');
}

function approve() {
  state.log.unshift({ type: 'approve', at: new Date().toISOString(), trades: pendingTrades(), trust: trustSnapshot(),
    concepts: state.agents.map((a) => state.res[a.id]?.conceptText).filter(Boolean) });
  state.holdings = [...state.calc.w];
  persist();
  setOpen($('#trades'), $('#trades-toggle'), false);
  toast('✓ 모의 계좌에 반영했어요 · <button class="btn plain" data-sheet="log">기록 보기</button>');
}

function reject() {
  state.log.unshift({ type: 'reject', at: new Date().toISOString(), reason: $('#reject-text').value.trim(), trust: trustSnapshot() });
  $('#reject-text').value = '';
  setOpen($('#reject-panel'), $('#reject-open'), false);
  persist();
  toast('반려 사유를 기록했어요. 매매는 하지 않았어요.');
}

function persist() {
  store.set(LS_LOG, state.log);
  store.set(LS_HOLD, state.holdings);
  renderDecision();
  renderSteps();
  if (currentSheet === 'log') openSheet('log');
}

// ---------- 시트 (깊은 정보는 한 단계 아래에) ----------

let currentSheet = null;
let sheetTrigger = null;

const SHEETS = {
  data: () => ({
    title: '종목 데이터',
    body: `
      <section><p>위원들은 모두 이 표를 보고 의견을 냅니다. <b>샘플 데이터</b>이며 실제 시세·재무와 다릅니다.</p></section>
      <section class="table-scroll"><table>
        <tr><th>종목</th><th>시장 비중</th><th>PBR</th><th>PER</th><th>ROE</th><th>배당</th><th>12개월</th><th>3개월</th><th>변동성</th><th>최대낙폭</th></tr>
        ${state.assets.map((a) => `<tr><td><b>${esc(a.name)}</b> <span class="muted">${esc(a.sector)}</span></td><td>${pct(a.capWeight)}</td>
          <td>${a.pbr}배</td><td>${a.per}배</td><td>${a.roe}%</td><td>${a.div}%</td>
          <td class="${sign(a.ret12m / 100)}">${a.ret12m}%</td><td class="${sign(a.ret3m / 100)}">${a.ret3m}%</td><td>${a.vol}%</td><td>${a.mdd}%</td></tr>`).join('')}
      </table></section>
      <section><h3>용어</h3><dl class="glossary">
        <dt>시장 비중</dt><dd>시가총액 비율. 위원회가 아무 의견도 반영하지 않으면 이 비중을 그대로 따른다</dd>
        ${Object.entries(METRICS).map(([k, m]) => `<dt>${esc(m.label)}</dt><dd>${esc(HELP[k])}</dd>`).join('')}
      </dl></section>`,
  }),
  process: () => {
    const c = state.calc;
    const diff = Math.max(...state.zero.mu.map((m, i) => Math.abs(m - state.zero.pi[i])));
    return {
      title: '결정 과정',
      body: `
        <section><h3>누가 무엇을 했나</h3>
          <div class="flow">
            <span>종목 데이터<em>고정 샘플</em></span>→<span class="human">기준<em>위원장이 정함</em></span>→
            <span>기준에 맞는 종목<em>코드가 판정</em></span>→<span>의견과 근거<em>${state.mode === 'gemini' ? 'Gemini' : '오프라인 규칙'}</em></span>→
            <span class="human">믿음 정도<em>위원장이 조정</em></span>→<span>합치기<em>수식</em></span>→<span class="human">승인·반려<em>위원장</em></span>
          </div></section>
        <section><h3>의견 한 줄씩</h3>
          ${c.views.length ? `<div class="table-scroll"><table>
            <tr><th>위원</th><th>종목</th><th>주장</th><th style="text-align:left">근거</th><th>자신감</th><th>× 믿음</th><th>= 반영 강도</th><th>기대수익 변화</th></tr>
            ${c.views.map((v) => {
              const ag = agentOf(v.agentId);
              const why = state.res[v.agentId].views.find((x) => x.ticker === v.ticker)?.rationale ?? '';
              const vc = c.viewContrib.find((x) => x.agentId === v.agentId && x.ticker === v.ticker);
              return `<tr><td><span style="color:${ag.color}">●</span> ${esc(ag.name)}</td><td><b>${esc(nameOf(v.ticker))}</b></td>
                <td class="${sign(v.q)}">${pp(v.q)}</td><td class="wrap">${esc(why)}<br><span class="muted">기준: ${esc(state.res[v.agentId].conceptText)}</span></td>
                <td>${pct(v.cAgent, 0)}</td><td>${pct(v.trust, 0)}</td><td><b>${pct(v.c, 0)}</b></td>
                <td class="${vc ? sign(vc.vec[v.asset]) : ''}">${vc ? pp(vc.vec[v.asset], 2) : '반영 안 됨'}</td></tr>`;
            }).join('')}</table></div>` : '<p class="muted">아직 의견이 없어요.</p>'}
        </section>
        <section><h3>어떻게 합치나요</h3>
          <p>LLM이 말로 합치지 않고 <b>블랙-리터만(Black-Litterman)</b> 수식으로 합칩니다. 시장 비중이 암시하는 기대수익 π에서 출발해,
            각 의견 쪽으로 <b>반영 강도</b>(= 위원 자신감 × 위원장 믿음)만큼 끌어당긴 뒤, 롱온리·비중 합 100% 조건에서 포트폴리오를 계산합니다.</p>
          <div class="formula">μ = π + τΣPᵀ(PτΣPᵀ + Ω)⁻¹(Q − Pπ),  Ωₖ = τ·pₖΣpₖᵀ·(1 − c)/c</div>
          <p class="check">검산 ✓ 모든 믿음을 0으로 두면 μ = π (최대 오차 ${diff.toExponential(1)})</p>
          <div class="table-scroll" style="margin-top:10px"><table>
            <tr><th>종목</th><th>시장이 암시한 기대수익 π</th><th>반영 후 μ</th><th>시장 비중</th><th>위원회 안</th></tr>
            ${state.assets.map((a, i) => `<tr><td>${esc(a.name)}</td><td>${pct(c.pi[i])}</td><td><b>${pct(c.mu[i])}</b></td><td>${pct(c.wMkt[i])}</td><td><b>${pct(c.w[i])}</b></td></tr>`).join('')}
          </table></div>
        </section>`,
    };
  },
  log: () => {
    const time = (iso) => new Date(iso).toLocaleString('ko-KR', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    return {
      title: '모의 매매 기록',
      body: `
        <section><ul class="log">${state.log.length ? state.log.map((e) => e.type === 'approve'
          ? `<li><b>승인</b> <span class="t">${time(e.at)} · ${esc(e.trust)}</span>
              <ul>${e.trades.map((t) => `<li class="${sign(t.to - t.from)}">${esc(t.name)} ${pct(t.from)} → ${pct(t.to)} · ${t.to > t.from ? '매수' : '매도'} ${won(Math.abs(t.to - t.from) * CAPITAL)}</li>`).join('')}</ul>
              <span class="t">적용된 기준: ${e.concepts.map(esc).join(' / ')}</span></li>`
          : `<li><b>반려</b> <span class="t">${time(e.at)} · ${esc(e.trust)}</span><br>사유: ${esc(e.reason)}</li>`).join('')
          : '<li class="muted">아직 기록이 없어요. 승인하면 모의 매매가, 반려하면 사유가 남습니다.</li>'}</ul></section>
        <section><button class="btn tinted small danger" id="reset-log">모의 계좌와 기록 초기화</button></section>`,
    };
  },
};

function openSheet(kind, trigger) {
  const { title, body } = SHEETS[kind]();
  currentSheet = kind;
  if (trigger) sheetTrigger = trigger;
  $('#sheet-title').textContent = title;
  $('#sheet-body').innerHTML = body;
  $('#sheet').inert = false;
  document.body.classList.add('sheet-open');
  $('#sheet-close').focus({ preventScroll: true });
}

function closeSheet() {
  currentSheet = null;
  document.body.classList.remove('sheet-open');
  $('#sheet').inert = true;
  sheetTrigger?.focus({ preventScroll: true });
}

// ---------- 이벤트 ----------

function bind() {
  $('#convene').addEventListener('click', () => {
    state.agents.forEach((ag) => requestView(ag.id));
    $('#convene').textContent = '다시 묻기';
    $('#convene').className = 'btn tinted';
  });

  const agents = $('#agents');
  agents.addEventListener('input', (e) => {
    const card = e.target.closest('.agent');
    if (!card) return;
    const id = card.dataset.id;
    if (e.target.matches('[data-trust]')) {
      agentOf(id).trust = Number(e.target.value) / 100;
      recompute();
    } else if (e.target.closest('.editor')) {
      readDraft(id);
      if (e.target.matches('[data-f="metric"]')) {
        e.target.closest('[data-rule]').querySelector('.rule-help').textContent = HELP[e.target.value];
      }
      updatePreview(id);
    }
  });
  agents.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const id = btn.closest('.agent').dataset.id;
    const ag = agentOf(id);
    const act = btn.dataset.act;
    if (act === 'why') {
      const open = !state.whyOpen.has(id);
      if (open) state.whyOpen.add(id); else state.whyOpen.delete(id);
      setOpen(cardOf(id).querySelector('[data-why]'), btn, open);
    } else if (act === 'edit') {
      state.editing[id] = structuredClone({ concept: ag.concept, direction: ag.direction });
      renderCard(id);
      cardOf(id).querySelector('[data-f="term"]').focus();
    } else if (act === 'add-rule' || act === 'del-rule') {
      readDraft(id);
      const rules = state.editing[id].concept.rules;
      if (act === 'add-rule') rules.push({ metric: 'per', op: '<', value: 10 });
      else rules.splice(Number(btn.closest('[data-rule]').dataset.rule), 1);
      renderCard(id);
    } else if (act === 'cancel') {
      delete state.editing[id];
      renderCard(id);
    } else if (act === 'commit') {
      readDraft(id);
      Object.assign(ag, state.editing[id]);
      delete state.editing[id];
      requestView(id);
    } else if (act === 'retry') {
      requestView(id);
    }
  });

  // 슬라이더를 끄는 동안에는 막대가 손가락을 1:1로 따라오게 트랜지션을 끈다
  agents.addEventListener('pointerdown', (e) => {
    if (e.target.matches('[data-trust]')) document.body.classList.add('scrubbing');
  });
  const endScrub = () => document.body.classList.remove('scrubbing');
  window.addEventListener('pointerup', endScrub);
  window.addEventListener('pointercancel', endScrub);

  $('#contrib-toggle').addEventListener('click', (e) => setOpen($('#contrib'), e.currentTarget, !$('#contrib').classList.contains('open')));
  $('#trades-toggle').addEventListener('click', (e) => setOpen($('#trades'), e.currentTarget, !$('#trades').classList.contains('open')));
  $('#reject-open').addEventListener('click', (e) => {
    const open = !$('#reject-panel').classList.contains('open');
    setOpen($('#reject-panel'), e.currentTarget, open);
    if (open) $('#reject-text').focus({ preventScroll: true });
  });
  $('#reject-cancel').addEventListener('click', () => setOpen($('#reject-panel'), $('#reject-open'), false));
  $('#reject-text').addEventListener('input', () => { $('#reject').disabled = !$('#reject-text').value.trim(); });
  $('#approve').addEventListener('click', approve);
  $('#reject').addEventListener('click', reject);

  document.addEventListener('click', (e) => {
    const trigger = e.target.closest('[data-sheet]');
    if (trigger) openSheet(trigger.dataset.sheet, trigger);
    if (e.target.id === 'reset-log') {
      state.log = [];
      state.holdings = state.assets.map((a) => a.capWeight);
      persist();
    }
  });
  $('#scrim').addEventListener('click', closeSheet);
  $('#sheet-close').addEventListener('click', closeSheet);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && currentSheet) closeSheet(); });

  const toolbar = $('#toolbar');
  window.addEventListener('scroll', () => toolbar.classList.toggle('scrolled', window.scrollY > 4), { passive: true });

  setInterval(() => {
    document.querySelectorAll('[data-elapsed]').forEach((el) => {
      el.textContent = `${((Date.now() - Number(el.dataset.elapsed)) / 1000).toFixed(1)}초`;
    });
  }, 100);
}

async function init() {
  const cfg = await fetch(`${API_BASE}/api/config`).then((r) => r.json());
  state.assets = cfg.data.assets;
  state.mode = cfg.mode;
  state.model = cfg.model;
  state.holdings = store.get(LS_HOLD, null) || state.assets.map((a) => a.capWeight);
  state.log = store.get(LS_LOG, []);
  const gemini = cfg.mode === 'gemini';
  $('#mode-pill').textContent = gemini ? 'Gemini' : '오프라인';
  $('#mode-pill').title = gemini ? `모델 ${cfg.model}` : 'GEMINI_API_KEY가 없어 기준에서 규칙으로 의견을 만듭니다';
  $('#committee-hint').textContent = gemini
    ? '세 위원에게 같은 종목 데이터를 주고 Gemini로 의견을 묻습니다.'
    : '지금은 Gemini 키가 없어 각 위원의 기준으로 의견을 만듭니다.';
  renderAgents();
  buildPortfolioRows();
  bind();
  recompute();
}

init();
