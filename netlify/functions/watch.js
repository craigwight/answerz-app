// netlify/functions/watch.js
// Permanent video hosting + branded "watch" page for Answerz creator demos.
// - POST /api/watch  { source, slug, brand, question }
//     Fetches the (temporary) Arcads video URL server-side, stores it in
//     Netlify Blobs, and returns a clean permanent { watchUrl, videoUrl }.
// - GET  /w/:slug   → branded player page (share THIS link in emails)
// - GET  /v/:slug   → the raw mp4, streamed from Blobs
// Netlify Blobs is built in on Netlify — no API key or package.json needed.

import { getStore } from "@netlify/blobs";

export const config = { path: ["/w/:slug", "/v/:slug", "/api/watch"] };

const GREEN = "#00A44F";
const esc = (s) => String(s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const json = (o, status = 200) =>
  new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "access-control-allow-origin": "*" } });

export default async (req, context) => {
  const url = new URL(req.url);
  const path = url.pathname;
  const store = getStore("answerz-videos");

  // ---- SAVE: host a video permanently ----
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

  // ---- VIDEO bytes ----
  if (path.startsWith("/v/")) {
    const data = await store.get(`v/${slug}`, { type: "arrayBuffer" });
    if (!data) return new Response("Not found", { status: 404 });
    return new Response(data, { headers: { "content-type": "video/mp4", "cache-control": "public, max-age=31536000, immutable" } });
  }

  // ---- WATCH page ----
  const entry = await store.getWithMetadata(`v/${slug}`, { type: "arrayBuffer" });
  if (!entry) return new Response("Video not found", { status: 404 });
  const brand = esc((entry.metadata && entry.metadata.brand) || "Your brand");
  const question = esc((entry.metadata && entry.metadata.question) || "");

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
<video controls autoplay muted playsinline src="/v/${esc(slug)}"></video>
<a class="cta" href="https://www.tribeezsocial.com/answerz#start">Get your full Answerz Share &rarr;</a>
<div class="disc"><b>AI DEMO</b> — this preview uses an AI-generated creator to show the format. Your live Answerz campaigns are made with real creators.</div>
<div class="foot">an&#9656;swerz &mdash; a Tribeez product</div></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
};
