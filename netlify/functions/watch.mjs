// netlify/functions/watch.mjs
// Permanent video hosting + branded "watch" page for Answerz creator demos.
// - POST /api/watch { source, slug, brand, question }  → host now, return {watchUrl,videoUrl}
// - GET  /w/:slug[?src=&brand=&q=]  → branded player page. If ?src is present and the
//        slug isn't stored yet, it fetches + stores the video on first load (self-host),
//        so a headless caller only needs to build the link — the first open makes it permanent.
// - GET  /v/:slug[?src=]  → the raw mp4 (also self-hosts from ?src on first load)
// Netlify Blobs is built in — no key needed (declared in package.json).

import { getStore } from "@netlify/blobs";

export const config = { path: ["/w/:slug", "/v/:slug", "/api/watch"] };

const GREEN = "#00A44F";
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

async function ensureStored(store, slug, url) {
  const existing = await store.get(`v/${slug}`, { type: "arrayBuffer" }).catch(() => null);
  if (existing) return true;
  const src = url.searchParams.get("src");
  if (!src) return false;
  try {
    const r = await fetch(src);
    if (!r.ok) return false;
    const buf = await r.arrayBuffer();
    await store.set(`v/${slug}`, buf, {
      metadata: { brand: url.searchParams.get("brand") || "", question: url.searchParams.get("q") || "" },
    });
    return true;
  } catch { return false; }
}

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const store = getStore("answerz-videos");

  // ---- SAVE via POST ----
  if (path === "/api/watch" && req.method === "POST") {
    let b;
    try { b = await req.json(); } catch { return json({ error: "bad json" }, 400); }
    const { source, slug, brand = "", question = "" } = b || {};
    if (!source || !slug) return json({ error: "source and slug required" }, 400);
    const r = await fetch(source);
    if (!r.ok) return json({ error: "could not fetch source video", status: r.status }, 502);
    const buf = await r.arrayBuffer();
    await store.set(`v/${slug}`, buf, { metadata: { brand, question } });
    return json({ ok: true, watchUrl: `${url.origin}/w/${slug}`, videoUrl: `${url.origin}/v/${slug}` });
  }

  const slug = context.params && context.params.slug;
  if (!slug) return new Response("Not found", { status: 404 });

  // self-host from ?src on first load (works for both /w and /v)
  await ensureStored(store, slug, url);

  // ---- VIDEO bytes (chunked HTTP Range so browsers can stream/seek) ----
  // Netlify synchronous functions cap the response body at ~6 MB, so we NEVER
  // return the whole file. Every response is a 206 partial capped at MAX_CHUNK.
  // The browser (which always sends a Range for <video>) fetches the file in
  // pieces — including the small tail chunk that holds the moov index — so
  // playback starts even though this mp4's moov atom sits at the end.
  if (path.startsWith("/v/")) {
    const data = await store.get(`v/${slug}`, { type: "arrayBuffer" });
    if (!data) return new Response("Not found", { status: 404 });
    const total = data.byteLength;
    const MAX_CHUNK = 4 * 1024 * 1024; // 4 MB, safely under Netlify's 6 MB limit
    const base = {
      "content-type": "video/mp4",
      "accept-ranges": "bytes",
      "cache-control": "public, max-age=31536000, immutable",
    };
    // Parse Range (default to an open-ended request from 0 when absent)
    let start = 0, end = total - 1;
    const m = /bytes=(\d*)-(\d*)/.exec(req.headers.get("range") || "");
    if (m) {
      start = m[1] === "" ? 0 : parseInt(m[1], 10);
      end = m[2] === "" ? total - 1 : parseInt(m[2], 10);
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= total) end = total - 1;
    }
    if (start > end || start >= total) {
      return new Response("Range Not Satisfiable", { status: 416, headers: { ...base, "content-range": `bytes */${total}` } });
    }
    // Cap the served window so the body never exceeds the function limit
    if (end - start + 1 > MAX_CHUNK) end = start + MAX_CHUNK - 1;
    const chunk = data.slice(start, end + 1);
    return new Response(chunk, {
      status: 206,
      headers: { ...base, "content-range": `bytes ${start}-${end}/${total}`, "content-length": String(chunk.byteLength) },
    });
  }

  // ---- WATCH page ----
  const entry = await store.getWithMetadata(`v/${slug}`, { type: "arrayBuffer" });
  const metaBrand = entry && entry.metadata && entry.metadata.brand;
  const metaQ = entry && entry.metadata && entry.metadata.question;
  const brand = esc(metaBrand || url.searchParams.get("brand") || "Your brand");
  const question = esc(metaQ || url.searchParams.get("q") || "");
  if (!entry && !url.searchParams.get("src")) return new Response("Video not found", { status: 404 });

  const html = `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${brand} — an&#9656;swerz</title>
<link href="https://fonts.googleapis.com/css2?family=Asap+Condensed:wght@700&family=Inter+Tight:wght@300;400;600&family=IBM+Plex+Mono:wght@500&display=swap" rel="stylesheet">
<style>*{box-sizing:border-box;margin:0;padding:0}body{background:#000;color:#C8CCD6;font-family:'Inter Tight',sans-serif;font-weight:300;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:30px 18px;-webkit-font-smoothing:antialiased}
.wm{font-family:'Asap Condensed',sans-serif;font-weight:700;font-size:28px;color:#fff;display:inline-flex;align-items:center;letter-spacing:-.01em}
.wm i{display:inline-block;background:${GREEN};width:.17em;height:.38em;margin:0 .12em;clip-path:polygon(50% 0,100% 100%,0 100%);transform:rotate(90deg);position:relative;top:.06em}
.tag{font-family:'IBM Plex Mono',monospace;font-size:11px;letter-spacing:.15em;text-transform:uppercase;color:#8E94A2;margin:10px 0 20px}
.q{font-family:'Asap Condensed',sans-serif;font-weight:700;text-transform:uppercase;color:#fff;font-size:clamp(20px,4.5vw,30px);line-height:1.05;text-align:center;max-width:18ch;margin-bottom:20px}
video{width:100%;max-width:340px;border:1px solid #232630;border-radius:16px;background:#0D0E11;display:block}
.cta{margin-top:26px;display:inline-block;background:${GREEN};color:#001b0d;font-family:'Asap Condensed',sans-serif;font-weight:700;text-transform:uppercase;letter-spacing:.02em;font-size:15px;text-decoration:none;padding:14px 26px;border-radius:8px}
.disc{font-family:'IBM Plex Mono',monospace;font-size:10.5px;color:#8E94A2;margin-top:22px;max-width:40ch;text-align:center;line-height:1.55}.disc b{color:#FBED1D}
.foot{font-family:'IBM Plex Mono',monospace;font-size:10px;color:#5A606C;margin-top:24px;letter-spacing:.12em;text-transform:uppercase}</style></head>
<body><div class="wm">an<i></i>swerz</div><div class="tag">${brand} &middot; the answer</div>
${question ? `<div class="q">${question}</div>` : ""}
<video controls autoplay muted playsinline src="/v/${esc(slug)}${url.searchParams.get("src") ? "?src=" + encodeURIComponent(url.searchParams.get("src")) : ""}"></video>
<a class="cta" href="https://www.tribeezsocial.com/answerz#start">Get your full Answerz Share &rarr;</a>
<div class="disc"><b>AI DEMO</b> — this preview uses an AI-generated creator to show the format. Your live Answerz campaigns are made with real creators.</div>
<div class="foot">an&#9656;swerz &mdash; a Tribeez product</div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
};
