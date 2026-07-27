// Answerz — Share of Search engine  (DataForSEO edition)
// GET /api/sos?brand=&category=&market=&competitors=   -> Share of Search + question bank
// GET /api/sos?mode=suggest&brand=&market=             -> suggested competitors
//
// Env vars required (Netlify → Site configuration → Environment variables):
//   DATAFORSEO_LOGIN      your DataForSEO API login
//   DATAFORSEO_PASSWORD   your DataForSEO API password
//
// NOTE: uses the *Google Trends* endpoint (real Google Trends data), NOT the
// cheaper "DataForSEO Trends" product, which is a different proprietary index.

const DFS = "https://api.dataforseo.com/v3";

// Markets we offer. DataForSEO takes location_name directly, so this is just
// the allow-list + the ISO code we keep for reference.
const MARKETS = {
  "netherlands": "NL", "united kingdom": "GB", "germany": "DE", "france": "FR",
  "belgium": "BE", "ireland": "IE", "spain": "ES", "italy": "IT",
  "poland": "PL", "sweden": "SE", "denmark": "DK", "norway": "NO",
  "austria": "AT", "switzerland": "CH", "portugal": "PT",
  "south africa": "ZA", "nigeria": "NG", "kenya": "KE",
  "namibia": "NA", "botswana": "BW",
  "united states": "US", "canada": "CA", "australia": "AU", "india": "IN"
};

const JSON_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
};

// ---- cache (per warm instance) ----
const MEM = new Map();
const TTL_MS = 24 * 60 * 60 * 1000;
const MEM_MAX = 200;
const cacheKey = o => [o.brand, o.market, o.category || "", (o.competitors || []).join("|")]
  .join("::").toLowerCase().replace(/\s+/g, " ").trim();
function cacheGet(k){ const m = MEM.get(k); if (m && m.exp > Date.now()) return m.data; if (m) MEM.delete(k); return null; }
function cacheSet(k, d){ if (MEM.size >= MEM_MAX) { const f = MEM.keys().next().value; if (f) MEM.delete(f); } MEM.set(k, { exp: Date.now() + TTL_MS, data: d }); }

// ---- hard timeout that cannot hang, even if abort fails ----
// This is the fix for the old version: AbortController alone did not kill
// connections that were black-holed, so the function ran forever.
function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error((label || "request") + " timed out")), ms))
  ]);
}

async function dfsPost(path, body, ms) {
  const login = process.env.DATAFORSEO_LOGIN;
  const password = process.env.DATAFORSEO_PASSWORD;
  if (!login || !password) throw new Error("DataForSEO credentials are not set on the server.");
  const auth = Buffer.from(login + ":" + password).toString("base64");
  const ctrl = new AbortController();
  const id = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await withTimeout(fetch(DFS + path, {
      method: "POST",
      headers: { "authorization": "Basic " + auth, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }), ms + 500, path);
    const j = await r.json();
    if (j.status_code && j.status_code !== 20000) throw new Error(j.status_message || ("DataForSEO error " + j.status_code));
    return j;
  } finally { clearTimeout(id); }
}

function resolveMarket(input) {
  const s = (input || "South Africa").trim();
  const hit = Object.keys(MARKETS).find(k => k === s.toLowerCase());
  return hit ? s : "South Africa";
}
const titleCase = s => s.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1));

// ---- Google Trends via DataForSEO (live) ----
async function runTrends(terms, brand, market) {
  const j = await dfsPost("/keywords_data/google_trends/explore/live", [{
    keywords: terms.slice(0, 5),
    location_name: market,
    language_code: "en",
    time_range: "past_12_months",
    item_types: ["google_trends_graph"]
  }], 12000);

  const task = (j.tasks || [])[0];
  if (!task) throw new Error("No response from Google Trends.");
  if (task.status_code && task.status_code !== 20000) throw new Error(task.status_message || "Google Trends task failed.");

  const result = (task.result || [])[0] || {};
  const graph = (result.items || []).find(i => i.type === "google_trends_graph");
  const points = (graph && graph.data) || [];

  const sums = terms.map(() => 0), counts = terms.map(() => 0);
  points.forEach(pt => (pt.values || []).forEach((v, i) => {
    if (i < terms.length) { sums[i] += (typeof v === "number" ? v : 0); counts[i] += 1; }
  }));

  const avgs = terms.map((t, i) => counts[i] ? sums[i] / counts[i] : 0);
  const total = avgs.reduce((a, b) => a + b, 0) || 1;
  const board = terms.map((t, i) => ({
    name: t,
    avg: Math.round(avgs[i] * 10) / 10,
    share: Math.round((avgs[i] / total) * 100),
    you: t.toLowerCase() === brand.toLowerCase()
  })).sort((a, b) => b.avg - a.avg);

  const you = board.find(x => x.you) || board[board.length - 1];
  const leader = board[0];
  const gapX = (you && you.avg > 0) ? Math.round((leader.avg / you.avg) * 10) / 10 : null;
  return { sorted: board, you, leader, gapX };
}

// ---- Buyer questions: People Also Ask via DataForSEO SERP ----
async function buildQuestions(brand, category, market) {
  const seed = category || brand;
  const queries = [seed, "best " + seed];
  const out = [], seen = new Set();
  const results = await Promise.allSettled(queries.map(q =>
    dfsPost("/serp/google/organic/live/advanced", [{
      keyword: q, location_name: market, language_code: "en", depth: 20
    }], 12000)
  ));
  results.forEach(r => {
    if (r.status !== "fulfilled") return;
    const items = (((r.value.tasks || [])[0] || {}).result || [])[0];
    ((items && items.items) || []).forEach(it => {
      if (it.type !== "people_also_ask") return;
      (it.items || []).forEach(q => {
        const t = (q.title || "").trim();
        const low = t.toLowerCase();
        if (!t || seen.has(low) || t.length > 110) return;
        seen.add(low);
        out.push({ q: t, platform: "Google" });
      });
    });
  });
  return out;
}

// ---- Competitor suggestions: related searches from the same SERP call ----
async function suggestCompetitors(brand, market) {
  try {
    const j = await dfsPost("/serp/google/organic/live/advanced", [{
      keyword: brand + " alternative", location_name: market, language_code: "en", depth: 10
    }], 9000);
    const res = (((j.tasks || [])[0] || {}).result || [])[0] || {};
    const pool = [];
    (res.items || []).forEach(it => {
      if (it.type === "related_searches") (it.items || []).forEach(s => pool.push(String(s)));
      if (it.type === "people_also_ask") (it.items || []).forEach(q => pool.push(String(q.title || "")));
    });
    const bl = brand.toLowerCase().trim();
    const counts = {};
    pool.forEach(s => {
      let low = s.toLowerCase();
      let tail = null;
      if (low.includes(" vs ")) tail = low.split(" vs ").pop();
      else if (low.includes(" or ")) tail = low.split(" or ").pop();
      else if (low.includes(" like ")) tail = low.split(" like ").pop();
      else if (low.includes("alternative to ")) tail = low.split("alternative to ").pop();
      if (!tail) return;
      tail = tail.replace(/[?]/g, "").replace(/\b(review|reviews|price|reddit|20\d\d|which is better|better)\b/g, "").trim();
      if (!tail || tail.length < 2) return;
      const name = tail.split(/\s+/).slice(0, 3).join(" ").trim();
      const nl = name.toLowerCase();
      if (!name || nl === bl || nl.includes(bl) || bl.includes(nl.split(" ")[0])) return;
      counts[name] = (counts[name] || 0) + 1;
    });
    const ranked = Object.keys(counts).filter(n => n.length >= 2).sort((a, b) => counts[b] - counts[a]);
    const out = [], seen = new Set();
    for (const n of ranked) {
      const k = n.replace(/\s+/g, "");
      if (seen.has(k)) continue;
      seen.add(k); out.push(titleCase(n));
      if (out.length >= 4) break;
    }
    return out;
  } catch (_) {
    return [];   // never hang, never throw — an empty list is a fine outcome
  }
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const brand = (p.brand || "").trim();
  const market = resolveMarket(p.market || p.geo);
  if (!brand) return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "Missing brand" }) };

  // ---- suggestions ----
  if ((p.mode || "") === "suggest") {
    const competitors = await suggestCompetitors(brand, market);
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ brand, market, competitors }) };
  }

  const category = (p.category || "").trim();
  const competitors = (p.competitors || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 4);
  const terms = [brand, ...competitors];

  const k = cacheKey({ brand, market, category, competitors });
  const hit = cacheGet(k);
  if (hit) return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(Object.assign({}, hit, { cached: true })) };

  const [trendsR, questionsR] = await Promise.allSettled([
    runTrends(terms, brand, market),
    buildQuestions(brand, category, market)
  ]);

  if (trendsR.status !== "fulfilled") {
    return {
      statusCode: 502, headers: JSON_HEADERS,
      body: JSON.stringify({ error: "Share of Search is temporarily unavailable: " + trendsR.reason.message })
    };
  }
  const trends = trendsR.value;
  const questions = questionsR.status === "fulfilled" ? questionsR.value : [];

  const payload = {
    brand, market, category, timeframe: "past 12 months",
    leaderboard: trends.sorted, you: trends.you, leader: trends.leader, gapX: trends.gapX,
    questions: questions.slice(0, 8),
    questionCount: questions.length,
    source: "Google Trends (relative) via DataForSEO + People Also Ask"
  };
  cacheSet(k, payload);
  return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(payload) };
};
