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

import { getStore } from "@netlify/blobs";

const DFS = "https://api.dataforseo.com/v3";
const WANT = 8;

// ---------------------------------------------------------------------------
// CACHE — two layers. Eleven SERP calls a run adds up on a public page, and
// every miss is a paid DataForSEO credit.
//
//   L1  in-process Map. Free, instant, dies when the instance goes cold.
//   L2  Netlify Blobs. Survives cold starts and deploys, so a brand demoed
//       once stays free — that is the layer that makes repeat demos cost
//       nothing.
//
// L2 is entirely best-effort. Every blob call is wrapped: if Blobs is
// unavailable, misconfigured or slow, we fall through to a live SERP exactly
// as before. The cache must never be able to break the engine.
// ---------------------------------------------------------------------------
const MEM = new Map();
const TTL = 30 * 24 * 60 * 60 * 1000;   // 30 days — SERPs move slowly enough
const MEM_MAX = 400;
const BLOB_MS = 1500;                    // never let the cache slow a request
const ckey = (...p) => p.join("::").toLowerCase().replace(/\s+/g, " ").trim();
const bkey = k => Buffer.from(k).toString("base64url").slice(0, 300);

let _store, _storeErr = null;
async function store() {
  if (_store !== undefined) return _store;
  try { _store = getStore("answerz-serp-cache"); }
  catch (e) { _storeErr = String(e && e.message || e); _store = null; }
  return _store;
}

const timeout = (p, ms) => Promise.race([
  p, new Promise(res => setTimeout(() => res(null), ms))
]);

async function cGet(k) {
  const m = MEM.get(k);
  if (m && m.exp > Date.now()) return m.d;
  if (m) MEM.delete(k);
  try {
    const s = await store();
    if (!s) return null;
    const raw = await timeout(s.get(bkey(k), { type: "json" }), BLOB_MS);
    if (raw && raw.exp > Date.now() && raw.d) {
      // promote back into L1 so the rest of this run is instant
      MEM.set(k, { exp: raw.exp, d: raw.d });
      return raw.d;
    }
  } catch {}
  return null;
}

async function cSet(k, d) {
  const exp = Date.now() + TTL;
  if (MEM.size >= MEM_MAX) MEM.delete(MEM.keys().next().value);
  MEM.set(k, { exp, d });
  try {
    const s = await store();
    if (s) await timeout(s.setJSON(bkey(k), { exp, d }), BLOB_MS);
  } catch {}
}

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

// Route directly rather than via the /api/* redirect. Going through the
// redirect invokes this in v1 compatibility mode, where Netlify does NOT
// inject the Blobs context — which is what kept the durable cache dark.
export const config = { path: "/api/answerz-gap" };

export default async (req) => {
  const p = Object.fromEntries(new URL(req.url).searchParams);
  const mode     = (p.mode || "questions").toLowerCase();
  // ?fresh=1 skips both cache layers — for when the number has to be live.
  // Costs a SERP credit every time, so it is opt-in, never the default.
  const fresh    = /^(1|true|yes)$/i.test(p.fresh || "");
  const brand    = (p.brand || "").trim();
  const product  = (p.product || "").trim();
  const category = (p.category || "").trim();
  const market   = (p.market || "South Africa").trim();

  const domainRaw = (p.domain || p.url || "").trim();
  const brandDomains = domainRaw
    ? [domainRaw.replace(/^https?:\/\//,"").replace(/^www\./,"").split("/")[0].toLowerCase()]
    : [brand.toLowerCase().replace(/[^a-z0-9]/g,"")];

  // ?debug=cache — is the durable layer actually alive? Read-only, no SERP spend.
  if ((p.debug || "") === "cache") {
    const s = await store();
    let write = null, read = null;
    if (s) {
      try { await s.setJSON("__probe", { exp: Date.now() + 60000, d: "ok" }); write = "ok"; }
      catch (e) { write = String(e && e.message || e); }
      try { const r = await s.get("__probe", { type: "json" }); read = r && r.d; }
      catch (e) { read = String(e && e.message || e); }
    }
    return new Response(JSON.stringify({
      hasStore: !!s, storeError: _storeErr, write, read, memSize: MEM.size
    }), { status: 200, headers: HDRS });
  }

  if (!brand) {
    return new Response(JSON.stringify({ error: "Add a brand." }), { status: 400, headers: HDRS });
  }

  if (mode === "questions") {
    if (!category) {
      return new Response(JSON.stringify({ error: "Add a category." }), { status: 400, headers: HDRS });
    }

    const problem = (p.problem || "").trim().toLowerCase().replace(/^(it |we |our product )/, "");
    const ck = ckey("q", category, market, problem);
    const hit = fresh ? null : await cGet(ck);
    if (hit) {
      return new Response(JSON.stringify(
        Object.assign({}, hit, { brand, questions: withOwn(hit.questions, p.ownq, WANT), cached: true })), { status: 200, headers: HDRS });
    }

    // Seeding on the problem reaches the high-intent questions. Seeding on the
    // category alone returns generic ones a brand can be absent from harmlessly.
    const seeds = problem
      ? [category, "best " + category + " for " + problem, "how to " + problem, "why " + problem]
      : [category, "best " + category, category + " vs"];

    const got = await Promise.allSettled(seeds.map(s => serp(s, market, 12000, 10)));
    const lists = got.filter(g => g.status === "fulfilled").map(g => items(g.value));

    if (!lists.length) {
      return new Response(JSON.stringify({
        error: "We couldn't reach the search data just now. Try again in a moment."
      }), { status: 502, headers: HDRS });
    }

    const found = harvest(lists, category, brand);
    if (found.length < 3) {
      return new Response(JSON.stringify({
        thin: true, brand, category, market, questions: found,
        message: "We could only find " + found.length + " question" + (found.length===1?"":"s") +
                 " for that category in " + market + ". Try a broader category."
      }), { status: 200, headers: HDRS });
    }

    const payload = {
      brand, category, market,
      questions: found,
      totalFound: found.length,
      seededOn: problem ? "the problem you named" : "the category",
      note: "Real questions, harvested live from Google People Also Ask and related searches."
    };
    await cSet(ck, payload);
    return new Response(JSON.stringify(
      Object.assign({}, payload, { questions: withOwn(found, p.ownq, WANT) })), { status: 200, headers: HDRS });
  }

  const q = (p.q || "").trim();
  if (!q) return new Response(JSON.stringify({ error: "Add a question." }), { status: 400, headers: HDRS });

  const sk = ckey("s", brand, product, brandDomains[0] || "", market, q);
  const shit = fresh ? null : await cGet(sk);
  if (shit) return new Response(JSON.stringify(
    Object.assign({}, shit, { cached: true })), { status: 200, headers: HDRS });

  try {
    const j = await serp(q, market, 18000, 20);
    const out = Object.assign({ brand, market, question: q }, scoreOne(j, brand, brandDomains, product));
    await cSet(sk, out);
    return new Response(JSON.stringify(out), { status: 200, headers: HDRS });
  } catch (e) {
    return new Response(JSON.stringify({
      brand, market, question: q, error: true, message: String(e.message || e)
    }), { status: 200, headers: HDRS });
  }
};
