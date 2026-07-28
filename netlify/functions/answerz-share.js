// Answerz Share — Search + Google AI Overview measurement
//
// A measurement service. It holds no client data: you pass the questions in.
//
//   POST /api/answerz-share
//     { "brand": "Dr Oetker",
//       "market": "South Africa",
//       "domains": ["droetker.co.za"],
//       "questions": [ {"cluster":"01 launch","q":"what is a calzone"} ] }
//
//   GET  /api/answerz-share?brand=X&market=Y&q=question one|question two
//
// Max 5 questions per call. Env: DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD

const DFS = "https://api.dataforseo.com/v3";
const BATCH = 5;
const DEPTH = 20;

const HDRS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
};

const CREATOR  = ["tiktok.com","youtube.com","instagram.com","facebook.com","reddit.com","pinterest.com"];
const RETAILER = ["checkers.co.za","picknpay.co.za","spar.co.za","takealot.com","woolworths.co.za",
                  "makro.co.za","shoprite.co.za","game.co.za","sixty60"];

function classify(domain, brandDomains) {
  const d = (domain || "").toLowerCase();
  if (brandDomains.some(b => d.includes(b))) return "Brand-owned";
  if (CREATOR.some(c => d.includes(c)))      return "Creator";
  if (RETAILER.some(r => d.includes(r)))     return "Retailer";
  return "Third party";
}
const band = p => p === 0 ? "Absent" : p <= 3 ? "Top 3" : p <= 10 ? "Top 10" : "Beyond 10";

const race = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error((label||"call") + " timed out")), ms))
]);

async function serp(keyword, market, ms) {
  const login = process.env.DATAFORSEO_LOGIN, pass = process.env.DATAFORSEO_PASSWORD;
  if (!login || !pass) throw new Error("DataForSEO credentials missing on the server");
  const auth = Buffer.from(login + ":" + pass).toString("base64");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await race(fetch(DFS + "/serp/google/organic/live/advanced", {
      method: "POST",
      headers: { authorization: "Basic " + auth, "content-type": "application/json" },
      body: JSON.stringify([{ keyword, location_name: market, language_code: "en", depth: DEPTH }]),
      signal: ctrl.signal
    }), ms + 500, "SERP");
    if (r.status === 401) throw new Error("DataForSEO rejected the credentials (401)");
    if (r.status === 402) throw new Error("DataForSEO account out of funds (402)");
    const j = await r.json();
    if (j.status_code && j.status_code !== 20000) throw new Error("DataForSEO " + j.status_code + ": " + (j.status_message||""));
    return j;
  } finally { clearTimeout(t); }
}

function readOne(json, brand, brandDomains) {
  const task = (json.tasks || [])[0];
  if (!task) throw new Error("empty response");
  if (task.status_code && task.status_code !== 20000) throw new Error(task.status_message || "task failed");
  const res = (task.result || [])[0] || {};
  const items = res.items || [];

  const organic = items.filter(i => i.type === "organic").map((i, idx) => ({
    pos: i.rank_absolute || idx + 1,
    domain: i.domain || "",
    title: (i.title || "").slice(0, 110),
    url: i.url || ""
  }));

  const bl = brand.toLowerCase();
  const hit = organic.find(o =>
    brandDomains.some(b => (o.domain||"").toLowerCase().includes(b)) ||
    (o.title||"").toLowerCase().includes(bl) ||
    (o.url||"").toLowerCase().includes(bl.replace(/\s+/g,""))
  );

  const paa = (items.find(i => i.type === "people_also_ask") || {}).items || [];
  const rel = (items.find(i => i.type === "related_searches") || {}).items || [];

  // Google AI Overview — arrives in the same SERP call, no extra cost
  const aio = items.find(i => i.type === "ai_overview");
  let aiOverview = { present: false };
  if (aio) {
    const parts = [];
    const walk = n => {
      if (!n || typeof n !== "object") return;
      if (typeof n.text === "string") parts.push(n.text);
      if (typeof n.title === "string") parts.push(n.title);
      (n.items || []).forEach(walk);
    };
    walk(aio);
    const text = parts.join(" ").replace(/\s+/g, " ").trim();

    const refs = [];
    const grabRefs = n => {
      if (!n || typeof n !== "object") return;
      (n.references || []).forEach(r => refs.push({
        domain: r.domain || "", title: (r.title || "").slice(0, 90), url: r.url || ""
      }));
      (n.items || []).forEach(grabRefs);
    };
    grabRefs(aio);

    const namedInText = text.toLowerCase().includes(bl);
    const citedRef = refs.find(r => brandDomains.some(b => (r.domain||"").toLowerCase().includes(b)));

    aiOverview = {
      present: true,
      brandNamed: namedInText,
      brandCited: !!citedRef,
      citedUrl: citedRef ? citedRef.url : null,
      status: citedRef ? "Cited" : namedInText ? "Named only" : "Absent",
      sources: refs.slice(0, 8).map(r => ({
        domain: r.domain, who: classify(r.domain, brandDomains), title: r.title
      })),
      sourceCount: refs.length,
      excerpt: text.slice(0, 320)
    };
  }

  return {
    appears: !!hit,
    position: hit ? hit.pos : 0,
    band: band(hit ? hit.pos : 0),
    source: hit ? classify(hit.domain, brandDomains) : "None",
    hitUrl: hit ? hit.url : null,
    hitTitle: hit ? hit.title : null,
    ownedBy: organic.slice(0, 5).map(o => ({
      pos: o.pos, domain: o.domain, who: classify(o.domain, brandDomains), title: o.title
    })),
    resultsSeen: organic.length,
    aiOverview,
    peopleAlsoAsk: paa.map(q => q.title).filter(Boolean).slice(0, 5),
    relatedSearches: rel.slice(0, 5)
  };
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};

  let body = {};
  if (event.body) {
    try { body = JSON.parse(event.body); }
    catch (e) {
      return { statusCode: 400, headers: HDRS, body: JSON.stringify({ error: "Body is not valid JSON" }) };
    }
  }

  const brand  = (body.brand  || p.brand  || "").trim();
  const market = (body.market || p.market || "South Africa").trim();

  let picked = [];
  if (Array.isArray(body.questions) && body.questions.length) {
    picked = body.questions.slice(0, BATCH).map(item =>
      typeof item === "string"
        ? { cluster: "", q: item.trim() }
        : { cluster: (item.cluster || "").trim(), q: (item.q || item.question || "").trim() }
    ).filter(x => x.q);
  } else if (p.q) {
    picked = p.q.split("|").map(s => s.trim()).filter(Boolean).slice(0, BATCH)
             .map(q => ({ cluster: "", q }));
  }

  if (!brand || !picked.length) {
    return { statusCode: 400, headers: HDRS, body: JSON.stringify({
      error: "Provide a brand and at least one question.",
      maxPerCall: BATCH,
      post: { brand: "BRAND", market: "MARKET", domains: ["brand.co.za"],
              questions: [{ cluster: "01", q: "a buyer question" }] },
      get: "/api/answerz-share?brand=X&market=Y&q=one|two|three"
    })};
  }

  const rawDomains = body.domains || p.domains || brand.toLowerCase().replace(/[^a-z0-9]/g, "");
  const brandDomains = (Array.isArray(rawDomains) ? rawDomains : String(rawDomains).split(","))
    .map(s => String(s).trim().toLowerCase()).filter(Boolean);

  const brandedTerms = (body.brandedTerms || [brand]).map(t => String(t).toLowerCase());
  const isBranded = q => brandedTerms.some(t => q.toLowerCase().includes(t));

  const settled = await Promise.allSettled(picked.map(x => serp(x.q, market, 18000)));

  const rows = settled.map((s, i) => {
    const { cluster, q } = picked[i];
    const base = { cluster, question: q, branded: isBranded(q) ? "Branded" : "Non-branded", surface: "Search" };
    if (s.status !== "fulfilled") {
      return Object.assign(base, { error: String(s.reason && s.reason.message || s.reason) });
    }
    try { return Object.assign(base, readOne(s.value, brand, brandDomains)); }
    catch (e) { return Object.assign(base, { error: e.message }); }
  });

  const ok = rows.filter(r => !r.error);
  const appears = ok.filter(r => r.appears);
  const withAio = ok.filter(r => r.aiOverview && r.aiOverview.present);
  const aioNamed = withAio.filter(r => r.aiOverview.brandNamed);
  const aioCited = withAio.filter(r => r.aiOverview.brandCited);

  return { statusCode: 200, headers: HDRS, body: JSON.stringify({
    brand, market, surface: "Search",
    measured: ok.length,
    failed: rows.length - ok.length,
    appearsCount: appears.length,
    coverageThisCall: ok.length ? Math.round((appears.length / ok.length) * 100) : null,
    aiOverview: {
      questionsWithOverview: withAio.length,
      brandNamed: aioNamed.length,
      brandCited: aioCited.length,
      note: "Named = the answer mentions the brand. Cited = the brand's own page is a source. Cited is stronger."
    },
    note: "Search surface plus Google AI Overviews. ChatGPT and Perplexity via /api/answerz-ai. Social and Video remain manual.",
    rows
  })};
};
