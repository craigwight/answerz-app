// Answerz Share — AI answers surface (ChatGPT · Perplexity · Gemini)
//
//   GET /api/answerz-ai?brand=BRAND&q=THE%20QUESTION&market=MARKET
//   GET /api/answerz-ai?brand=BRAND&q=...&runs=3&engine=chatgpt|perplexity|gemini
//   Optional: &domains=brand.com,brand.co.za  (decides Cited vs Named only)
//
// ONE QUESTION PER CALL, deliberately. DataForSEO's live LLM endpoints can take
// up to 120s and Netlify caps at 26s, so batching would simply time out.
//
// LLM output is non-deterministic — that is why runs exists. Three runs is the
// floor for anything you intend to report. The modal result is what counts.
//
// Env: DATAFORSEO_LOGIN, DATAFORSEO_PASSWORD

const DFS = "https://api.dataforseo.com/v3";

const ENGINES = {
  chatgpt:    { path: "/ai_optimization/chat_gpt/llm_responses/live",   model: "gpt-4.1-mini",      label: "ChatGPT" },
  perplexity: { path: "/ai_optimization/perplexity/llm_responses/live", model: "sonar",             label: "Perplexity" },
  gemini:     { path: "/ai_optimization/gemini/llm_responses/live",     model: "gemini-2.0-flash",  label: "Gemini" }
};

const HDRS = {
  "content-type": "application/json",
  "access-control-allow-origin": "*",
  "cache-control": "no-store"
};

const race = (p, ms, label) => Promise.race([
  p, new Promise((_, rej) => setTimeout(() => rej(new Error((label||"call") + " timed out after " + ms + "ms")), ms))
]);

async function ask(engineKey, prompt, ms) {
  const login = process.env.DATAFORSEO_LOGIN, pass = process.env.DATAFORSEO_PASSWORD;
  if (!login || !pass) throw new Error("DataForSEO credentials missing on the server");
  const eng = ENGINES[engineKey];
  if (!eng) throw new Error("Unknown engine: " + engineKey);

  const auth = Buffer.from(login + ":" + pass).toString("base64");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await race(fetch(DFS + eng.path, {
      method: "POST",
      headers: { authorization: "Basic " + auth, "content-type": "application/json" },
      body: JSON.stringify([{
        user_prompt: prompt.slice(0, 500),
        model_name: eng.model,
        web_search: true,
        temperature: 0.3
      }]),
      signal: ctrl.signal
    }), ms + 500, eng.label);
    if (r.status === 401) throw new Error("DataForSEO rejected the credentials (401)");
    if (r.status === 402) throw new Error("DataForSEO account out of funds (402)");
    const j = await r.json();
    if (j.status_code && j.status_code !== 20000) throw new Error("DataForSEO " + j.status_code + ": " + (j.status_message||""));
    return j;
  } finally { clearTimeout(t); }
}

function readAnswer(json) {
  const task = (json.tasks || [])[0];
  if (!task) throw new Error("empty response");
  if (task.status_code && task.status_code !== 20000) throw new Error(task.status_message || "task failed");
  const res = (task.result || [])[0] || {};

  const texts = [], links = [];
  const walk = n => {
    if (!n || typeof n !== "object") return;
    if (typeof n.text === "string") texts.push(n.text);
    if (typeof n.content === "string") texts.push(n.content);
    if (typeof n.url === "string") links.push(n.url);
    (n.annotations || []).forEach(walk);
    (n.sections || []).forEach(walk);
    (n.items || []).forEach(walk);
    (n.messages || []).forEach(walk);
    if (n.message && typeof n.message === "object") walk(n.message);
  };
  walk(res);

  return {
    text: texts.join(" ").replace(/\s+/g," ").trim(),
    links: [...new Set(links)].slice(0, 12),
    cost: task.cost || 0
  };
}

const domainOf = u => { try { return new URL(u).hostname.replace(/^www\./,"").toLowerCase(); } catch(e){ return ""; } };

exports.handler = async (event) => {
  const p = event.queryStringParameters || {};
  const brand    = (p.brand || "").trim();
  const question = (p.q || "").trim();
  const engine   = (p.engine || "chatgpt").toLowerCase();
  const runs     = Math.min(Math.max(parseInt(p.runs || "3", 10) || 3, 1), 3);

  if (!brand || !question) {
    return { statusCode: 400, headers: HDRS, body: JSON.stringify({
      error: "Missing brand or q",
      usage: "/api/answerz-ai?brand=BRAND&q=QUESTION&market=MARKET&engine=chatgpt&runs=3",
      engines: Object.keys(ENGINES)
    })};
  }

  const brandDomains = (p.domains || brand.toLowerCase().replace(/[^a-z0-9]/g,""))
    .split(",").map(s => s.trim().toLowerCase()).filter(Boolean);

  const market = (p.market || "South Africa").trim();
  const prompt = question + " (" + market + ")";

  const perRun = runs === 1 ? 22000 : runs === 2 ? 11000 : 7000;

  const settled = await Promise.allSettled(
    Array.from({ length: runs }, () => ask(engine, prompt, perRun))
  );

  const bl = brand.toLowerCase();
  const results = settled.map((s, i) => {
    if (s.status !== "fulfilled") return { run: i+1, error: String(s.reason && s.reason.message || s.reason) };
    try {
      const a = readAnswer(s.value);
      const named = a.text.toLowerCase().includes(bl);
      const cited = a.links.some(u => brandDomains.some(b => domainOf(u).includes(b)));
      return {
        run: i+1,
        brandNamed: named,
        brandCited: cited,
        status: cited ? "Cited" : named ? "Named only" : "Absent",
        sources: a.links.slice(0,8).map(u => ({ domain: domainOf(u), url: u })),
        excerpt: a.text.slice(0, 340),
        cost: a.cost
      };
    } catch (e) { return { run: i+1, error: e.message }; }
  });

  const ok = results.filter(r => !r.error);
  const namedCount = ok.filter(r => r.brandNamed).length;
  const citedCount = ok.filter(r => r.brandCited).length;

  let modal = "Absent";
  if (ok.length) {
    if (citedCount > ok.length / 2) modal = "Cited";
    else if (namedCount > ok.length / 2) modal = "Named only";
  }

  return { statusCode: 200, headers: HDRS, body: JSON.stringify({
    brand, market, question, engine: (ENGINES[engine]||{}).label || engine,
    surface: "AI answers",
    runsRequested: runs,
    runsCompleted: ok.length,
    runsFailed: results.length - ok.length,
    brandNamedIn: namedCount + "/" + ok.length,
    brandCitedIn: citedCount + "/" + ok.length,
    modalResult: modal,
    consistent: ok.length > 1 && (namedCount === 0 || namedCount === ok.length),
    note: ok.length < runs
      ? "Some runs timed out. DataForSEO live LLM endpoints can take up to 120s; Netlify caps at 26s. Re-run, or use runs=1 for a longer single attempt."
      : "Modal result across runs. LLM output is non-deterministic — never report a single run.",
    totalCost: ok.reduce((a,r) => a + (r.cost||0), 0),
    runs: results
  })};
};
