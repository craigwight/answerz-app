// Answerz — Share of Search engine
// GET /api/sos?brand=&category=&market=&competitors=   -> Share of Search + question bank
// GET /api/sos?mode=suggest&brand=&market=             -> suggested competitors
//
// Env (Netlify → Site configuration → Environment variables):
//   DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD
//
// Data strategy: try real Google Trends first. DataForSEO cap that endpoint
// across all their users and it often fails to answer, so if it doesn't come
// back fast we fall back to DataForSEO Trends (their clickstream index).
// The response carries `source` so the page can label it honestly.

const DFS = "https://api.dataforseo.com/v3";

const MARKETS = {
  "netherlands":1,"united kingdom":1,"germany":1,"france":1,"belgium":1,"ireland":1,
  "spain":1,"italy":1,"poland":1,"sweden":1,"denmark":1,"norway":1,"austria":1,
  "switzerland":1,"portugal":1,"south africa":1,"nigeria":1,"kenya":1,"namibia":1,
  "botswana":1,"united states":1,"canada":1,"australia":1,"india":1
};

const HDRS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
};

// ---- cache ----
const MEM = new Map();
const TTL = 24 * 60 * 60 * 1000;
const key = o => [o.brand,o.market,o.category||"",(o.competitors||[]).join("|")].join("::").toLowerCase().trim();
const cGet = k => { const m = MEM.get(k); if (m && m.exp > Date.now()) return m.d; if (m) MEM.delete(k); return null; };
const cSet = (k,d) => { if (MEM.size >= 200) MEM.delete(MEM.keys().next().value); MEM.set(k,{exp:Date.now()+TTL,d}); };

// ---- a timeout that always fires, even if abort doesn't ----
const race = (p, ms, label) => Promise.race([
  p, new Promise((_,rej) => setTimeout(() => rej(new Error((label||"call") + " timed out after " + ms + "ms")), ms))
]);

async function dfs(path, body, ms) {
  const login = process.env.DATAFORSEO_LOGIN, pass = process.env.DATAFORSEO_PASSWORD;
  if (!login || !pass) throw new Error("DataForSEO credentials missing on the server");
  const auth = Buffer.from(login + ":" + pass).toString("base64");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await race(fetch(DFS + path, {
      method: "POST",
      headers: { authorization: "Basic " + auth, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal
    }), ms + 500, path);
    if (r.status === 401) throw new Error("DataForSEO rejected the credentials (401)");
    if (r.status === 402) throw new Error("DataForSEO account out of funds (402)");
    const j = await r.json();
    if (j.status_code && j.status_code !== 20000) throw new Error("DataForSEO " + j.status_code + ": " + (j.status_message || "unknown"));
    return j;
  } finally { clearTimeout(t); }
}

const market = v => {
  const s = (v || "South Africa").trim();
  return MARKETS[s.toLowerCase()] ? s : "South Africa";
};
const title = s => s.replace(/\w\S*/g, t => t[0].toUpperCase() + t.slice(1));
const isoDaysAgo = n => new Date(Date.now() - n*864e5).toISOString().slice(0,10);

// Pull the value series out of whatever graph shape comes back.
function seriesFrom(json, count) {
  const task = (json.tasks || [])[0];
  if (!task) throw new Error("empty response");
  if (task.status_code && task.status_code !== 20000) throw new Error(task.status_message || "task failed");
  const res = (task.result || [])[0] || {};
  const items = res.items || [];
  const graph = items.find(i => /graph/i.test(i.type || "")) || items[0];
  const points = (graph && (graph.data || graph.values)) || [];
  const sums = new Array(count).fill(0), n = new Array(count).fill(0);
  points.forEach(pt => {
    const vals = pt.values || pt.value || [];
    (Array.isArray(vals) ? vals : [vals]).forEach((v,i) => {
      if (i < count && typeof v === "number") { sums[i] += v; n[i] += 1; }
    });
  });
  const avgs = sums.map((s,i) => n[i] ? s/n[i] : 0);
  if (!avgs.some(a => a > 0)) throw new Error("no usable data points");
  return avgs;
}

// A term with a zero average means the platform has no data for that string —
// not that the brand owns none of the category. Those are different findings
// and must never be shown as "0% share".
const NO_DATA = 0;          // literally nothing returned
const DWARF_RATIO = 60;     // leader this many times bigger = mismatched set

// Try real Google Trends, fall back to DataForSEO Trends.
async function runTrends(terms, brand, mkt) {
  const kws = terms.slice(0,5);
  let avgs = null, source = null, note = null;

  try {
    const j = await dfs("/keywords_data/google_trends/explore/live", [{
      keywords: kws, location_name: mkt, language_code: "en",
      date_from: isoDaysAgo(365), date_to: isoDaysAgo(1), type: "web"
    }], 9000);
    avgs = seriesFrom(j, kws.length);
    source = "Google Trends";
  } catch (e) {
    note = e.message;
  }

  if (!avgs) {
    const j = await dfs("/keywords_data/dataforseo_trends/explore/live", [{
      keywords: kws, location_name: mkt,
      date_from: isoDaysAgo(365), date_to: isoDaysAgo(1)
    }], 12000);
    avgs = seriesFrom(j, kws.length);
    source = "DataForSEO Trends";
  }

  const noData   = kws.filter((t,i) => avgs[i] <= NO_DATA);
  const withData = kws.filter((t,i) => avgs[i] >  NO_DATA);
  const brandIdx = kws.findIndex(t => t.toLowerCase() === brand.toLowerCase());
  const maxAvg   = Math.max.apply(null, avgs);
  const biggest  = kws[avgs.indexOf(maxAvg)];

  // Nothing at all for the brand — almost always a badly formed search term.
  if (brandIdx === -1 || avgs[brandIdx] <= NO_DATA) {
    const err = new Error("INSUFFICIENT_DATA");
    err.insufficient = true; err.reason = "no_brand_data";
    err.noData = noData; err.withData = withData;
    throw err;
  }

  // Not enough terms to compare against.
  if (withData.length < 2) {
    const err = new Error("INSUFFICIENT_DATA");
    err.insufficient = true; err.reason = "too_few_terms";
    err.noData = noData; err.withData = withData;
    throw err;
  }

  // The brand has real demand but a giant in the set has flattened it.
  // Google Trends is relative, so this is a set-selection problem, not a result.
  if (maxAvg / avgs[brandIdx] > DWARF_RATIO) {
    const err = new Error("INSUFFICIENT_DATA");
    err.insufficient = true; err.reason = "mismatched_set";
    err.biggest = biggest;
    err.noData = noData; err.withData = withData;
    throw err;
  }

  const total = avgs.reduce((a,b)=>a+b,0) || 1;
  const board = kws.map((t,i) => ({
    name: t,
    avg: Math.round(avgs[i]*10)/10,
    share: avgs[i] <= NO_DATA ? null : Math.round((avgs[i]/total)*100),
    noData: avgs[i] <= NO_DATA,
    you: t.toLowerCase() === brand.toLowerCase()
  })).sort((a,b) => b.avg - a.avg);

  const you = board.find(x => x.you) || board[board.length-1];
  const leader = board.find(x => !x.noData) || board[0];
  return {
    sorted: board, you, leader,
    gapX: (you && you.avg > 0) ? Math.round((leader.avg/you.avg)*10)/10 : null,
    source, fallbackReason: note,
    noDataTerms: noData
  };
}

async function questions(brand, category, mkt) {
  const seed = category || brand;
  const out = [], seen = new Set();
  const rs = await Promise.allSettled([seed, "best " + seed].map(q =>
    dfs("/serp/google/organic/live/advanced", [{ keyword:q, location_name:mkt, language_code:"en", depth:20 }], 12000)
  ));
  rs.forEach(r => {
    if (r.status !== "fulfilled") return;
    const res = (((r.value.tasks||[])[0]||{}).result||[])[0];
    ((res && res.items)||[]).forEach(it => {
      if (it.type !== "people_also_ask") return;
      (it.items||[]).forEach(q => {
        const t = (q.title||"").trim(), low = t.toLowerCase();
        if (!t || t.length > 110 || seen.has(low)) return;
        seen.add(low); out.push({ q:t, platform:"Google" });
      });
    });
  });
  return out;
}

async function suggest(brand, mkt) {
  try {
    const j = await dfs("/serp/google/organic/live/advanced",
      [{ keyword: brand + " alternative", location_name: mkt, language_code:"en", depth:10 }], 10000);
    const res = (((j.tasks||[])[0]||{}).result||[])[0] || {};
    const pool = [];
    (res.items||[]).forEach(it => {
      if (it.type === "related_searches") (it.items||[]).forEach(s => pool.push(String(s)));
      if (it.type === "people_also_ask") (it.items||[]).forEach(q => pool.push(String(q.title||"")));
    });
    const bl = brand.toLowerCase().trim(), counts = {};
    pool.forEach(s => {
      const low = s.toLowerCase();
      let tail = null;
      for (const sep of [" vs "," or "," like ","alternative to "]) {
        if (low.includes(sep)) { tail = low.split(sep).pop(); break; }
      }
      if (!tail) return;
      tail = tail.replace(/\?/g,"").replace(/\b(review|reviews|price|reddit|20\d\d|better|which is better)\b/g,"").trim();
      if (tail.length < 2) return;
      const name = tail.split(/\s+/).slice(0,3).join(" ").trim(), nl = name.toLowerCase();
      if (!name || nl === bl || nl.includes(bl) || bl.includes(nl.split(" ")[0])) return;
      counts[name] = (counts[name]||0) + 1;
    });
    return Object.keys(counts).sort((a,b)=>counts[b]-counts[a]).slice(0,4).map(title);
  } catch (_) { return []; }
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const brand = (p.brand||"").trim();
  const mkt = market(p.market || p.geo);
  if (!brand) return { statusCode:400, headers:HDRS, body:JSON.stringify({ error:"Missing brand" }) };

  if ((p.mode||"") === "suggest") {
    return { statusCode:200, headers:HDRS, body:JSON.stringify({ brand, market:mkt, competitors: await suggest(brand,mkt) }) };
  }

  const category = (p.category||"").trim();
  const competitors = (p.competitors||"").split(",").map(s=>s.trim()).filter(Boolean).slice(0,4);
  const terms = [brand, ...competitors];

  const k = key({brand,market:mkt,category,competitors});
  const hit = cGet(k);
  if (hit) return { statusCode:200, headers:HDRS, body:JSON.stringify(Object.assign({},hit,{cached:true})) };

  const [t, q] = await Promise.allSettled([ runTrends(terms,brand,mkt), questions(brand,category,mkt) ]);

  if (t.status !== "fulfilled") {
    const r = t.reason || {};
    if (r.insufficient) {
      const bad = (r.noData || []).join('", "');
      let title, message, hint;
      if (r.reason === "mismatched_set") {
        title   = "These brands aren't comparable.";
        message = '"' + r.biggest + '" is many times larger than ' + brand +
                  ', so on a relative scale everything else rounds to zero. '
                  + 'That tells you about the size gap, not about your share.';
        hint    = "Compare against rivals of a similar size — the ones a buyer would actually choose between.";
      } else if (r.reason === "too_few_terms") {
        title   = "Not enough rivals with search data.";
        message = 'We found data for "' + brand + '" but not for enough competitors to build a comparison.';
        hint    = "Try two or three well-known brand names in your category.";
      } else {
        title   = "Not enough search data for these terms.";
        message = 'There is no measurable search data for "' + bad + '". '
                  + 'Use the brand name on its own — location words, taglines and brackets have almost no search volume.';
        hint    = "Short brand names only. No cities, no descriptions, no brackets.";
      }
      return { statusCode:200, headers:HDRS, body:JSON.stringify({
        insufficientData: true, reason: r.reason,
        brand, market: mkt,
        noDataTerms: r.noData || [], withDataTerms: r.withData || [],
        biggest: r.biggest || null,
        error: title, message, hint
      })};
    }
    return { statusCode:502, headers:HDRS, body:JSON.stringify({
      error: "We couldn't pull your search data just now.",
      detail: String(r.message || r)
    })};
  }

  const qs = q.status === "fulfilled" ? q.value : [];
  const payload = {
    brand, market: mkt, category, timeframe: "past 12 months",
    leaderboard: t.value.sorted, you: t.value.you, leader: t.value.leader, gapX: t.value.gapX,
    questions: qs.slice(0,8), questionCount: qs.length,
    source: t.value.source,
    noDataTerms: t.value.noDataTerms || [],
    sourceNote: t.value.source === "Google Trends"
      ? "Live Google Trends · relative interest · past 12 months"
      : "Search demand index · relative interest · past 12 months"
  };
  cSet(k, payload);
  return { statusCode:200, headers:HDRS, body:JSON.stringify(payload) };
};
