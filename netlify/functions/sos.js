// Answerz — Share of Search engine
// GET /api/sos?brand=&category=&market=&competitors=   -> full Share of Search + question bank
// GET /api/sos?mode=suggest&brand=&market=             -> suggested competitors only (free)

const GEO = {
  "south africa": "ZA", "za": "ZA",
  "united states": "US", "usa": "US", "us": "US",
  "united kingdom": "GB", "uk": "GB", "gb": "GB",
  "australia": "AU", "au": "AU",
  "nigeria": "NG", "ng": "NG",
  "kenya": "KE", "ke": "KE",
  "namibia": "NA", "na": "NA",
  "botswana": "BW", "bw": "BW",
  "india": "IN", "in": "IN",
  "canada": "CA", "ca": "CA",
  "germany": "DE", "de": "DE",
  "france": "FR", "fr": "FR"
};

const JSON_HEADERS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
};

function resolveGeo(input) {
  const s = (input || "South Africa").trim();
  if (/^[A-Za-z]{2}$/.test(s)) return s.toUpperCase();
  return GEO[s.toLowerCase()] || "ZA";
}

function titleCase(s) {
  return s.replace(/\w\S*/g, t => t.charAt(0).toUpperCase() + t.slice(1));
}

// fetch with a hard timeout so nothing can hang the function
async function fetchT(url, ms, opts) {
  const c = new AbortController();
  const id = setTimeout(() => c.abort(), ms || 5000);
  try {
    return await fetch(url, Object.assign({ signal: c.signal }, opts || {}));
  } finally {
    clearTimeout(id);
  }
}

// Free Google autocomplete suggestions
async function autocomplete(seed, gl) {
  try {
    const su = new URL("https://www.google.com/complete/search");
    su.searchParams.set("client", "firefox");
    su.searchParams.set("hl", "en");
    su.searchParams.set("gl", gl);
    su.searchParams.set("q", seed);
    const r = await fetchT(su.toString(), 3500, { headers: { "user-agent": "Mozilla/5.0" } });
    const t = await r.text();
    let a = null; try { a = JSON.parse(t); } catch (_) {}
    return (a && Array.isArray(a[1])) ? a[1].map(String) : [];
  } catch (_) { return []; }
}

// SerpApi Google "People Also Ask" — real, well-formed buyer questions
async function paa(query, geo, key) {
  try {
    const u = new URL("https://serpapi.com/search.json");
    u.searchParams.set("engine", "google");
    u.searchParams.set("q", query);
    u.searchParams.set("gl", geo.toLowerCase());
    u.searchParams.set("hl", "en");
    u.searchParams.set("api_key", key);
    const r = await fetchT(u.toString(), 6000);
    const j = await r.json();
    return (j.related_questions || []).map(x => x.question).filter(Boolean);
  } catch (_) { return []; }
}

// Suggest competitors from autocomplete comparison intent (free — no SerpApi cost)
async function suggestCompetitors(brand, gl) {
  const bl = brand.toLowerCase().trim();
  const seeds = [brand + " vs ", brand + " or ", "brands like " + brand, brand + " alternative"];
  const res = await Promise.all(seeds.map(s => autocomplete(s, gl)));
  const counts = {};
  res.flat().forEach(sug => {
    let low = ("" + sug).toLowerCase().trim();
    let tail = null;
    if (low.includes(" vs ")) tail = low.split(" vs ").pop();
    else if (low.includes(" or ")) tail = low.split(" or ").pop();
    else if (low.startsWith("brands like ")) tail = low.slice("brands like ".length);
    else if (low.includes(" like ")) tail = low.split(" like ").pop();
    if (!tail) return;
    tail = tail.replace(/[?]/g, "").replace(/\b(review|reviews|price|reddit|20\d\d|south africa|which is better)\b/g, "").trim();
    if (!tail || tail.length < 2) return;
    const name = tail.split(/\s+/).slice(0, 3).join(" ").trim();
    if (!name) return;
    const nl = name.toLowerCase();
    // drop brand-name variants (e.g. Environ -> "environment", "environ xt")
    if (nl === bl || nl.includes(bl) || bl.includes(nl.split(" ")[0])) return;
    counts[name] = (counts[name] || 0) + 1;
  });
  const ranked = Object.keys(counts).filter(n => n.length >= 2).sort((a, b) => counts[b] - counts[a]);
  const out = [], seen = new Set();
  for (const n of ranked) {
    const k = n.replace(/\s+/g, "");
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(titleCase(n));
    if (out.length >= 4) break;
  }
  return out;
}

// Build a quality question bank: People Also Ask (real) + filtered autocomplete
async function buildQuestions(brand, category, geo, key) {
  const seedBase = category || brand;
  const gl = geo.toLowerCase();
  const seen = new Set();
  const out = [];
  const qwords = ["how", "why", "is", "are", "can", "does", "do", "what", "which", "should", "when", "will", "where"];

  const paaSeeds = [seedBase, `best ${seedBase}`];
  const acSeeds = [`${brand} vs`, `why is my`, `does ${seedBase}`, `how to use ${seedBase}`, `best ${seedBase} for`, `is ${seedBase} good`];

  // Run PAA (SerpApi) and autocomplete (free) all in parallel
  const [paaArrs, acArrs] = await Promise.all([
    Promise.all(paaSeeds.map(s => paa(s, geo, key))),
    Promise.all(acSeeds.map(s => autocomplete(s, gl)))
  ]);

  // 1) People Also Ask — real, complete questions
  paaArrs.flat().forEach(q => {
    let t = ("" + q).trim();
    const low = t.toLowerCase();
    if (!t || seen.has(low) || t.length > 110) return;
    seen.add(low);
    out.push({ q: t, platform: "Google" });
  });

  // 2) Autocomplete supplements — comparison + intent, strict filter
  acArrs.flat().forEach(s => {
    let t = ("" + s).trim();
    const low = t.toLowerCase();
    const words = low.split(/\s+/);
    const isQ = qwords.includes(words[0]) || low.includes(" vs ");
    if (!isQ || words.length < 4) return;               // drop fragments like "how to skincare"
    if (seen.has(low) || t.length < 14 || t.length > 95) return;
    seen.add(low);
    const clean = t.replace(/\?+$/, "");
    out.push({ q: clean.charAt(0).toUpperCase() + clean.slice(1) + "?", platform: "Google" });
  });

  return out;
}

// Google Trends (Share of Search) via SerpApi
async function runTrends(terms, brand, geo, key) {
  try {
    const u = new URL("https://serpapi.com/search.json");
    u.searchParams.set("engine", "google_trends");
    u.searchParams.set("q", terms.join(","));
    u.searchParams.set("geo", geo);
    u.searchParams.set("date", "today 12-m");
    u.searchParams.set("data_type", "TIMESERIES");
    u.searchParams.set("api_key", key);
    const r = await fetchT(u.toString(), 8000);
    const j = await r.json();
    if (j.error) throw new Error(j.error);
    const timeline = (j.interest_over_time && j.interest_over_time.timeline_data) || [];
    const sums = terms.map(() => 0), counts = terms.map(() => 0);
    timeline.forEach(pt => {
      (pt.values || []).forEach((v, i) => {
        const val = typeof v.extracted_value === "number" ? v.extracted_value : (parseFloat(v.value) || 0);
        sums[i] += val; counts[i] += 1;
      });
    });
    const avgs = terms.map((t, i) => counts[i] ? sums[i] / counts[i] : 0);
    const total = avgs.reduce((a, b) => a + b, 0) || 1;
    const board = terms.map((t, i) => ({
      name: t,
      avg: Math.round(avgs[i] * 10) / 10,
      share: Math.round((avgs[i] / total) * 100),
      you: t.toLowerCase() === brand.toLowerCase()
    }));
    const sorted = board.sort((a, b) => b.avg - a.avg);
    const you = sorted.find(x => x.you) || sorted[sorted.length - 1];
    const leader = sorted[0];
    const gapX = (you && you.avg > 0) ? Math.round((leader.avg / you.avg) * 10) / 10 : null;
    return { sorted, you, leader, gapX };
  } catch (e) {
    return { error: "Google Trends fetch failed: " + e.message };
  }
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const brand = (p.brand || "").trim();
  const geo = resolveGeo(p.geo || p.market);

  if (!brand) return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "Missing brand" }) };

  // ---- MODE: competitor suggestions (free, no key required) ----
  if ((p.mode || "") === "suggest") {
    const competitors = await suggestCompetitors(brand, geo.toLowerCase());
    return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({ brand, competitors }) };
  }

  const category = (p.category || "").trim();
  const competitors = (p.competitors || "").split(",").map(s => s.trim()).filter(Boolean).slice(0, 4);
  const key = process.env.SERPAPI_KEY;
  if (!key) return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: "SERPAPI_KEY is not set on the server. Add it in Netlify → Site settings → Environment variables." }) };

  const terms = [brand, ...competitors];

  // Run Trends and the question bank IN PARALLEL (keeps us well under the timeout)
  const [trends, questions] = await Promise.all([
    runTrends(terms, brand, geo, key),
    buildQuestions(brand, category, geo, key)
  ]);

  if (trends.error) {
    return { statusCode: 502, headers: JSON_HEADERS, body: JSON.stringify({ error: trends.error }) };
  }

  return {
    statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify({
      brand, geo, category, timeframe: "today 12-m",
      leaderboard: trends.sorted, you: trends.you, leader: trends.leader, gapX: trends.gapX,
      questions: questions.slice(0, 8),
      questionCount: questions.length,
      source: "Google Trends (relative) via SerpApi + People Also Ask + autocomplete"
    })
  };
};
