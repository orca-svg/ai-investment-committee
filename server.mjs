// AI 투자위원회 로컬 서버 (의존성 없음). 정적 파일 + Gemini 에이전트 호출.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { equilibrium, matchConcept, conceptText, METRICS } from './public/core.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');

// .env가 있으면 읽는다(이미 설정된 환경변수가 우선)
try {
  for (const line of fs.readFileSync(path.join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^['"]|['"]$/g, '');
  }
} catch {}

const KEY = process.env.GEMINI_API_KEY || '';
const PORT = Number(process.env.PORT || 4100);
const API = 'https://generativelanguage.googleapis.com/v1beta';
const data = JSON.parse(fs.readFileSync(path.join(root, 'data/sample.json'), 'utf8'));
const eq = equilibrium(data.assets);

async function resolveModel() {
  if (process.env.GEMINI_MODEL) return process.env.GEMINI_MODEL;
  try {
    const res = await fetch(`${API}/models?pageSize=200`, { headers: { 'x-goog-api-key': KEY } });
    const names = ((await res.json()).models || [])
      .filter((m) => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map((m) => m.name.replace('models/', ''));
    const flash = names
      .map((n) => ({ n, m: n.match(/^gemini-(\d+(?:\.\d+)?)-flash(-preview)?$/) }))
      .filter((x) => x.m)
      .sort((a, b) => Number(b.m[1]) - Number(a.m[1]) || (a.m[2] ? 1 : 0) - (b.m[2] ? 1 : 0));
    if (flash.length) return flash[0].n;
  } catch (e) {
    console.warn('모델 목록 조회 실패, 기본 모델 사용:', e.message);
  }
  return 'gemini-flash-latest';
}
const MODEL = KEY ? await resolveModel() : null;

const pct = (x) => `${(x * 100).toFixed(1)}%`;

function dataTable() {
  const head = '| 종목코드 | 종목명 | 업종 | 시총비중 | 균형 기대수익(π) | PBR | PER | ROE | 배당수익률 | 12개월 수익률 | 3개월 수익률 | 연 변동성 | 최대낙폭 |';
  const rows = data.assets.map((a, i) =>
    `| ${a.ticker} | ${a.name} | ${a.sector} | ${pct(a.capWeight)} | ${pct(eq.pi[i])} | ${a.pbr} | ${a.per} | ${a.roe}% | ${a.div}% | ${a.ret12m}% | ${a.ret3m}% | ${a.vol}% | ${a.mdd}% |`);
  return [head, '|' + ' --- |'.repeat(13), ...rows].join('\n');
}

function buildPrompt(agent, matched) {
  const name = (t) => data.assets.find((a) => a.ticker === t).name;
  const others = data.assets.filter((a) => !matched.includes(a.ticker)).map((a) => a.name);
  const dir = agent.direction > 0 ? '긍정적(균형 대비 초과수익 +)' : '부정적(균형 대비 초과수익 −)';
  const system = [
    `너는 'AI 투자위원회'의 위원인 「${agent.name}」이다.`,
    `투자 성향: ${agent.stance}`,
    `위원장이 확정한 개념 정의(이 정의만 사용한다): ${conceptText(agent.concept)}`,
    `이 정의에 해당하는 종목에 대한 기본 입장: ${dir}`,
    `코드가 정의를 데이터에 적용한 판정 결과 — 해당: ${matched.map(name).join(', ') || '없음'} / 비해당: ${others.join(', ')}`,
    '',
    '규칙:',
    '1. 견해는 1~3개. 각 견해는 한 종목에 대해 "시장이 이미 반영한 균형 기대수익(π) 대비 향후 12개월 초과수익(%p)"과 확신도(0.1~0.9)를 낸다.',
    '2. 판정에서 "해당"인 종목을 우선 다루고, 방향은 기본 입장을 따른다. 해당 종목이 없으면 정의에 가장 가까운 종목 1개에 낮은 확신도로 견해를 낸다.',
    '3. 초과수익은 -6 ~ +6 범위.',
    '4. rationale은 2문장 이내로, 아래 표의 수치를 최소 1개 인용하고 어떤 정의 조건에 걸렸는지 밝힌다.',
    '5. 표에 없는 정보(뉴스, 실적 전망 등)를 지어내지 않는다. 데이터는 샘플이다.',
  ].join('\n');
  const user = `유니버스 데이터(샘플):\n${dataTable()}\n\n위원장에게 제출할 견해를 JSON으로 작성하라.`;
  return { system, user };
}

const responseSchema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: '위원장에게 하는 한 문장 요약' },
    views: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          ticker: { type: 'STRING', enum: data.assets.map((a) => a.ticker) },
          excessReturnPct: { type: 'NUMBER', description: '균형 기대수익 대비 12개월 초과수익, %p' },
          confidence: { type: 'NUMBER', description: '0.1~0.9' },
          rationale: { type: 'STRING' },
        },
        required: ['ticker', 'excessReturnPct', 'confidence', 'rationale'],
        propertyOrdering: ['ticker', 'excessReturnPct', 'confidence', 'rationale'],
      },
    },
  },
  required: ['summary', 'views'],
  propertyOrdering: ['summary', 'views'],
};

function thinkingConfig(model) {
  if (/gemini-2\.5/.test(model)) return { thinkingBudget: 0 };
  if (/gemini-3/.test(model)) return { thinkingLevel: 'low' };
  return undefined;
}

async function callGemini({ system, user }) {
  const body = (withThinking) => JSON.stringify({
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema,
      temperature: 0.4,
      ...(withThinking && thinkingConfig(MODEL) ? { thinkingConfig: thinkingConfig(MODEL) } : {}),
    },
  });
  const send = (withThinking) => fetch(`${API}/models/${MODEL}:generateContent`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
    body: body(withThinking),
    signal: AbortSignal.timeout(60000),
  });
  let res = await send(true);
  if (res.status === 400) res = await send(false); // thinkingConfig를 모르는 모델 대비
  const json = await res.json();
  if (!res.ok) throw new Error(json.error?.message || `Gemini HTTP ${res.status}`);
  const text = (json.candidates?.[0]?.content?.parts || []).filter((p) => !p.thought).map((p) => p.text).join('');
  return JSON.parse(text);
}

// 키가 없을 때의 대체 견해: 개념 판정 결과만으로 규칙적으로 생성
function offlineViews(agent, matched) {
  const assets = data.assets.filter((a) => matched.includes(a.ticker)).slice(0, 3);
  const metrics = [...new Set(agent.concept.rules.map((r) => r.metric))];
  return {
    summary: assets.length
      ? `${agent.concept.term}에 해당하는 ${assets.map((a) => a.name).join(', ')}에 대해 ${agent.direction > 0 ? '긍정' : '부정'} 견해를 냅니다.`
      : `현재 정의에 해당하는 종목이 없어 견해를 내지 않습니다.`,
    views: assets.map((a) => ({
      ticker: a.ticker,
      excessReturnPct: 3 * agent.direction,
      confidence: 0.5,
      rationale: `${metrics.map((m) => `${METRICS[m].label} ${a[m]}${METRICS[m].unit}`).join(', ')}로 「${conceptText(agent.concept)}」 조건에 해당합니다. (오프라인 규칙 견해)`,
    })),
  };
}

function sanitize(out) {
  const tickers = new Set(data.assets.map((a) => a.ticker));
  const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Number(x) || 0));
  const seen = new Set();
  const views = (out.views || [])
    .filter((v) => tickers.has(v.ticker) && !seen.has(v.ticker) && seen.add(v.ticker))
    .slice(0, 3)
    .map((v) => ({
      ticker: v.ticker,
      excessReturnPct: Math.round(clamp(v.excessReturnPct, -6, 6) * 10) / 10,
      confidence: Math.round(clamp(v.confidence, 0.1, 0.9) * 100) / 100,
      rationale: String(v.rationale || ''),
    }));
  return { summary: String(out.summary || ''), views };
}

async function agentView(agent) {
  const matched = matchConcept(data.assets, agent.concept);
  const prompt = buildPrompt(agent, matched);
  const started = Date.now();
  const raw = KEY ? await callGemini(prompt) : offlineViews(agent, matched);
  return { ...sanitize(raw), matched, prompt: prompt.system, source: KEY ? MODEL : 'offline-rules', latencyMs: Date.now() - started };
}

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json' };
const send = (res, status, obj) => {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
};

// 배포에서는 화면을 GitHub Pages가, Gemini 호출을 이 서버(Cloud Run)가 맡는다. 키는 서버에만 있다.
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://orca-svg.github.io').split(',');
function allowCors(req, res) {
  const origin = req.headers.origin;
  if (!origin || !ALLOWED_ORIGINS.includes(origin)) return;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
}

// 공개 주소라 누구나 부를 수 있으므로, 위원 호출은 IP당 10분에 60회(의견 듣기 약 20번)로 막아 선불 크레딧을 지킨다.
const recentCalls = new Map();
function overLimit(req) {
  const ip = String(req.headers['x-forwarded-for'] || req.socket.remoteAddress).split(',')[0].trim();
  const now = Date.now();
  const calls = (recentCalls.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  calls.push(now);
  recentCalls.set(ip, calls);
  return calls.length > 60;
}

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  allowCors(req, res);
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  try {
    if (req.method === 'GET' && url.pathname === '/api/config') {
      return send(res, 200, { mode: KEY ? 'gemini' : 'offline', model: MODEL, data });
    }
    if (req.method === 'POST' && url.pathname === '/api/agent-view') {
      if (overLimit(req)) return send(res, 429, { error: '요청이 너무 많아요. 10분 뒤에 다시 시도해 주세요.' });
      let body = '';
      for await (const chunk of req) body += chunk;
      const { agent } = JSON.parse(body);
      const out = await agentView(agent);
      console.log(`[agent] ${agent.name} → ${out.views.length}개 견해 (${out.source}, ${out.latencyMs}ms)`);
      return send(res, 200, out);
    }
    const file = path.normalize(path.join(publicDir, url.pathname === '/' ? 'index.html' : url.pathname));
    if (!file.startsWith(publicDir) || !fs.existsSync(file)) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  } catch (e) {
    console.error('[error]', e.message);
    send(res, 500, { error: e.message });
  }
}).listen(PORT, () => {
  console.log(`AI 투자위원회: http://localhost:${PORT}`);
  console.log(KEY ? `Gemini 모드 — 모델 ${MODEL}` : '오프라인 모드 — GEMINI_API_KEY가 없어 규칙 기반 견해를 씁니다');
});
