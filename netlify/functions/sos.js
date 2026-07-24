// Answerz — Share of Search engine
// GET /api/sos?brand=Environ&category=Skincare&market=South Africa&competitors=The Ordinary,CeraVe,Dermalogica
// Pulls live Google Trends via SerpApi + a real question bank via Google autocomplete.

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

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const brand = (p.brand || "").trim();
  const category = (p.category || "").trim();
  const geo = resolveGeo(p.geo || p.market);
  const competitors = (p.competitors || "")
    .split(",").map(s => s.trim()).filter(Boolean).slice(0, 4);
  const key = process.env.SERPAPI_KEY;

  if (!brand) return { statusCode: 400, headers: JSON_HEADERS, body: JSON.stringify({ error: "Missing brand" }) };
  if (!key)   return { statusCode: 500, headers: JSON_HEADERS, body: JSON.stringify({ error: "SERPAPI_KEY is not set on the server. Add it in Netlify → Site settings → Environment variables." }) };

  const terms = [brand, ...competitors];

  // ---------- 1) Google Trends (Share of Search) via SerpApi ----------
  let sorted, you, leader, gapX;
  try {
    const u = new URL("https://serpapi.com/search.json");
    u.searchParams.set("engine", "google_trends");
    u.searchParams.set("q", terms.join(","));
    u.searchParams.set("geo", geo);
    u.searchParams.set("date", "today 12-m");
    u.searchParams.set("data_type", "TIMESERIES");
    u.searchParams.set("api_key", key);

    const r = await fetch(u.toString());
    const j = await r.json();
    if (j.error) throw new Error(j.error);

    const timeline = (j.interest_over_time && j.interest_over_time.timeline_data) || [];
    const sums = terms.map(() => 0);
    const counts = terms.map(() => 0);
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
    sorted = board.sort((a, b) => b.avg - a.avg);
    you = sorted.find(x => x.you) || sorted[sorted.length - 1];
    leader = sorted[0];
    gapX = (you && you.avg > 0) ? Math.round((leader.avg / you.avg) * 10) / 10 : null;
  } catch (e) {
    return { statusCode: 502, headers: JSON_HEADERS, body: JSON.stringify({ error: "Google Trends fetch failed: " + e.message }) };
  }

  // ---------- 2) Question bank via Google autocomplete (free) ----------
  const gl = geo.toLowerCase();
  const seedBase = category || brand;
  const seeds = [
    seedBase, `best ${seedBase}`, `how to ${seedBase}`, `${seedBase} for`,
    `is ${brand}`, `${brand} vs`, `why is my`, `how do i`, `can i use`, `what is the best ${seedBase}`
  ];
  const qWords = ["how", "why", "is", "are", "can", "does", "do", "what", "which", "should", "when", "will"];
  const seen = new Set();
  const questions = [];

  await Promise.all(seeds.map(async (seed) => {
    try {
      const su = new URL("https://www.google.com/complete/search");
      su.searchParams.set("client", "firefox");
      su.searchParams.set("hl", "en");
      su.searchParams.set("gl", gl);
      su.searchParams.set("q", seed);
      const rr = await fetch(su.toString(), { headers: { "user-agent": "Mozilla/5.0" } });
      const txt = await rr.text();
      let arr = null;
      try { arr = JSON.parse(txt); } catch (_) { arr = null; }
      const sugg = (arr && Array.isArray(arr[1])) ? arr[1] : [];
      sugg.forEach(s => {
        const t = ("" + s).trim();
        const low = t.toLowerCase();
        const isQuestion = qWords.some(w => low.startsWith(w + " ")) || low.includes(" vs ");
        if (isQuestion && !seen.has(low) && t.length >= 8 && t.length <= 90) {
          seen.add(low);
          questions.push({ q: t.charAt(0).toUpperCase() + t.slice(1), platform: "Google" });
        }
      });
    } catch (_) { /* ignore a single seed failing */ }
  }));

  const body = {
    brand, geo, category, timeframe: "today 12-m",
    leaderboard: sorted,
    you, leader, gapX,
    questions: questions.slice(0, 8),
    questionCount: questions.length,
    source: "Google Trends (relative, web search) via SerpApi + Google autocomplete"
  };
  return { statusCode: 200, headers: JSON_HEADERS, body: JSON.stringify(body) };
};
