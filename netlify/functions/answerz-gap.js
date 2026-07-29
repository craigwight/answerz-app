// Answerz Gap — free self-serve visibility test
//
//   STAGE 1  GET /api/answerz-gap?mode=questions&brand=X&category=Y&market=Z
//                                 &problem=...&ownq=...
//            → 8 buyer questions. Seeded on the problem when given — that
//              reaches the high-intent questions, which is where brands are
//              usually absent. Their own question, if supplied, goes first.
//
//   STAGE 2  GET /api/answerz-gap?mode=score&brand=X&product=Y&domain=x.co.za
//                                 &market=Z&q=...
//            → one question scored: Google + AI Overview
//
// Env: DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD

const DFS = "https://api.dataforseo.com/v3";
const WANT = 8;

// Cache per warm instance. Eleven SERP calls a run adds up on a public page.
const MEM = new Map();
const TTL = 24 * 60 * 60 * 1000;
const MEM_MAX = 400;
const ckey = (...p) => p.join("::").toLowerCase().replace(/\s+/g, " ").trim();
function cGet(k){ const m = MEM.get(k); if (m && m.exp > Date.now()) return m.d; if (m) MEM.delete(k); return null; }
function cSet(k, d){ if (MEM.size >= MEM_MAX) MEM.delete(MEM.keys().next().value); MEM.set(k, { exp: Date.now()+TTL, d }); }

const HDRS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
};

const CREATOR  = ["tiktok.com","youtube.com","instagram.com","facebook.com","reddit.com","pinterest.com"];
const RETAILER = ["amazon.","takealot.com","checkers.co.za","picknpay.co.za","spar.co.za",
                  "woolworths.co.za","makro.co.za","shoprite.co.za","bol.com","argos.co.uk"];

function classify(domain, brandDomains) {
  const d = (domain || "").toLowerCase();
  if (brandDomains.some(b => b && d.includes(b))) return "You";
  if (CREATOR.some(c => d.includes(c)))  return "Creator";
  if (RETAILER.some(r => d.includes(r))) return "Retailer";
  return "Someone else";
}

const race = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error((label||"call")+" timed out")), ms))
]);

async function serp(keyword, market, ms, depth) {
  const login = process.env.DATAFORSEO_LOGIN, pass = process.env.DATAFORSEO_PASSWORD;
  if (!login || !pass) throw new Error("Server not configured");
  const auth = Buffer.from(login + ":" + pass).toString("base64");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await race(fetch(DFS + "/serp/google/organic/live/advanced", {
      method: "POST",
      headers: { authorization: "Basic " + auth, "content-type": "application/json" },
      body: JSON.stringify([{ keyword, location_name: market, language_code: "en", depth: depth || 20 }]),
      signal: ctrl.signal
    }), ms + 500, "SERP");
    if (r.status === 401) throw new Error("Search data unavailable (auth)");
    if (r.status === 402) throw new Error("Search data unavailable (quota)");
    const j = await r.json();
    if (j.status_code && j.status_code !== 20000) throw new Error(j.status_message || "Search failed");
    return j;
  } finally { clearTimeout(t); }
}

const items = j => {
  const task = (j.tasks || [])[0];
  if (!task) return [];
  const res = (task.result || [])[0] || {};
  return res.items || [];
};

function harvest(all, category, brand) {
  const out = [], seen = new Set();
  const bl = (brand || "").toLowerCase();

  const push = (t, src) => {
    let q = String(t || "").trim();
    if (!q) return;
    q = q.replace(/\s+/g, " ");
    const low = q.toLowerCase();
    if (low.length < 12 || low.length > 95) return;
    if (seen.has(low)) return;
    const isQ = /\?$/.test(q) || /^(what|how|why|is|are|can|does|do|which|when|should|where|who)\b/i.test(q);
    if (!isQ) return;
    seen.add(low);
    out.push({ q: q.replace(/\?+$/,"") + "?", source: src, branded: bl && low.includes(bl) });
  };

  all.forEach(list => {
    list.forEach(it => {
      if (it.type === "people_also_ask") (it.items || []).forEach(x => push(x.title, "People Also Ask"));
      if (it.type === "related_searches") (it.items || []).forEach(x => push(x, "Related searches"));
    });
  });

  const cat = (category || "").toLowerCase().split(/\s+/).filter(w => w.length > 3);
  const score = o => {
    let s = 0;
    if (o.source === "People Also Ask") s += 3;
    if (cat.some(w => o.q.toLowerCase().includes(w))) s += 2;
    if (/^(how|what)\b/i.test(o.q)) s += 1;
    if (o.branded) s += 1;
    return -s;
  };
  return out.sort((a,b) => score(a) - score(b));
}

function scoreOne(j, brand, brandDomains, product) {
  const its = items(j);
  const bl = brand.toLowerCase();
  // A distinctly-named product ("Ristorante") may rank without the brand name in
  // the title. Missing that reads as Absent when the brand is actually present,
  // which is the worst error this tool can make.
  const terms = [bl, (product || "").trim().toLowerCase()].filter(Boolean);

  const organic = its.filter(i => i.type === "organic").map((i, idx) => ({
    pos: i.rank_absolute || idx + 1,
    domain: (i.domain || "").replace(/^www\./,""),
    title: (i.title || "").slice(0, 90)
  }));

  const hit = organic.find(o =>
    brandDomains.some(b => b && o.domain.toLowerCase().includes(b)) ||
    terms.some(t => t && o.title.toLowerCase().includes(t))
  );

  const aio = its.find(i => i.type === "ai_overview");
  let ai = { present: false };
  if (aio) {
    const parts = [];
    const walk = n => {
      if (!n || typeof n !== "object") return;
      if (typeof n.text === "string") parts.push(n.text);
      (n.items || []).forEach(walk);
    };
    walk(aio);
    const text = parts.join(" ").toLowerCase();
    const refs = [];
    const grab = n => {
      if (!n || typeof n !== "object") return;
      (n.references || []).forEach(r => refs.push((r.domain||"").toLowerCase()));
      (n.items || []).forEach(grab);
    };
    grab(aio);
    const cited = refs.some(d => brandDomains.some(b => b && d.includes(b)));
    const named = terms.some(t => text.includes(t));
    ai = { present: true, status: cited ? "Cited" : named ? "Named only" : "Absent" };
  }

  return {
    appears: !!hit,
    position: hit ? hit.pos : null,
    verdict: !hit ? "Absent" : hit.pos <= 3 ? "Top 3" : hit.pos <= 10 ? "Top 10" : "Beyond 10",
    aiOverview: ai,
    topThree: organic.slice(0, 3).map(o => ({
      pos: o.pos, domain: o.domain, who: classify(o.domain, brandDomains)
    }))
  };
}

// Their own question goes first — testing a question they know their customers
// ask is the most personal moment in the test. It is per-user, so it is spliced
// in rather than cached with the shared harvest.
function withOwn(list, ownRaw, want) {
  const own = (ownRaw || "").trim();
  let out = list.slice(0, own ? want - 1 : want);
  if (own) {
    const oq = own.replace(/\?+$/, "") + "?";
    out = [{ q: oq, source: "Your customers ask this", yours: true }]
          .concat(out.filter(x => x.q.toLowerCase() !== oq.toLowerCase()));
  }
  return out;
}

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const mode     = (p.mode || "questions").toLowerCase();
  const brand    = (p.brand || "").trim();
  const product  = (p.product || "").trim();
  const category = (p.category || "").trim();
  const market   = (p.market || "South Africa").trim();

  const domainRaw = (p.domain || p.url || "").trim();
  const brandDomains = domainRaw
    ? [domainRaw.replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0].toLowerCase()]
    : [brand.toLowerCase().replace(/[^a-z0-9]/g,"")];

  if (!brand) {
    return { statusCode: 400, headers: HDRS, body: JSON.stringify({ error: "Add a brand." }) };
  }

  if (mode === "questions") {
    if (!category) {
      return { statusCode: 400, headers: HDRS, body: JSON.stringify({ error: "Add a category." }) };
    }

    const problem = (p.problem || "").trim().toLowerCase().replace(/^(it |we |our product )/, "");
    const ck = ckey("q", category, market, problem);
    const hit = cGet(ck);
    if (hit) {
      return { statusCode: 200, headers: HDRS, body: JSON.stringify(
        Object.assign({}, hit, { brand, questions: withOwn(hit.questions, p.ownq, WANT), cached: true })) };
    }

    // Seeding on the problem reaches the high-intent questions. Seeding on the
    // category alone returns generic ones a brand can be absent from harmlessly.
    const seeds = problem
      ? [category, "best " + category + " for " + problem, "how to " + problem, "why " + problem]
      : [category, "best " + category, category + " vs"];

    const got = await Promise.allSettled(seeds.map(s => serp(s, market, 12000, 10)));
    const lists = got.filter(g => g.status === "fulfilled").map(g => items(g.value));

    if (!lists.length) {
      return { statusCode: 502, headers: HDRS, body: JSON.stringify({
        error: "We couldn't reach the search data just now. Try again in a moment."
      })};
    }

    const found = harvest(lists, category, brand);
    if (found.length < 3) {
      return { statusCode: 200, headers: HDRS, body: JSON.stringify({
        thin: true, brand, category, market, questions: found,
        message: "We could only find " + found.length + " question" + (found.length===1?"":"s") +
                 " for that category in " + market + ". Try a broader category."
      })};
    }

    const payload = {
      brand, category, market,
      questions: found,
      totalFound: found.length,
      seededOn: problem ? "the problem you named" : "the category",
      note: "Real questions, harvested live from Google People Also Ask and related searches."
    };
    cSet(ck, payload);
    return { statusCode: 200, headers: HDRS, body: JSON.stringify(
      Object.assign({}, payload, { questions: withOwn(found, p.ownq, WANT) })) };
  }

  const q = (p.q || "").trim();
  if (!q) return { statusCode: 400, headers: HDRS, body: JSON.stringify({ error: "Add a question." }) };

  const sk = ckey("s", brand, product, brandDomains[0] || "", market, q);
  const shit = cGet(sk);
  if (shit) return { statusCode: 200, headers: HDRS, body: JSON.stringify(
    Object.assign({}, shit, { cached: true })) };

  try {
    const j = await serp(q, market, 18000, 20);
    const out = Object.assign({ brand, market, question: q }, scoreOne(j, brand, brandDomains, product));
    cSet(sk, out);
    return { statusCode: 200, headers: HDRS, body: JSON.stringify(out) };
  } catch (e) {
    return { statusCode: 200, headers: HDRS, body: JSON.stringify({
      brand, market, question: q, error: true, message: String(e.message || e)
    })};
  }
};
