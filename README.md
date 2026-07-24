# Answerz — Share of Search tool

A self-serve tool: type a brand → confirm category + rivals → get a **live Google Trends Share of Search** read plus a real buyer-question bank. Front-end + a Netlify serverless function that pulls data from SerpApi (Google Trends) and Google autocomplete.

## What's in here
```
public/index.html            → the tool (front-end)
netlify/functions/sos.js     → the backend (live Share of Search + questions)
netlify.toml                 → config (publish dir + /api/sos route)
```

## Deploy (GitHub → Netlify) — ~5 minutes

1. **Put this folder in a GitHub repo.**
   - Create a new repo at github.com → upload these files (or `git init && git add . && git commit && git push`).
2. **Connect it to Netlify.**
   - Netlify → Add new site → **Import an existing project** → pick the GitHub repo.
   - Build settings are read automatically from `netlify.toml` (publish = `public`, functions = `netlify/functions`). Just click **Deploy**.
3. **Add your SerpApi key.**
   - Get a free key at **serpapi.com** (free tier = 100 searches/month).
   - Netlify → Site → **Site configuration → Environment variables → Add** → key name **`SERPAPI_KEY`**, value = your key.
   - Then **Deploys → Trigger deploy** so the function picks it up.
4. Done — visit the site URL, type a brand, and it pulls live data for any brand.

> Note: a static drag-and-drop deploy will **not** run the function. It must be a Git-connected deploy (or Netlify CLI) so the `netlify/functions` folder is included.

## Embed on Squarespace
Once live, add a Code Block at the top of your /answerz page:
```html
<iframe id="answerz" src="https://YOUR-SITE.netlify.app/"
  style="width:100%;border:0;display:block;min-height:640px;overflow:hidden"
  scrolling="no" title="Answerz — Share of Search"></iframe>
<script>
  window.addEventListener('message', function (e) {
    if (e.data && e.data.answerzHeight) {
      document.getElementById('answerz').style.height = e.data.answerzHeight + 'px';
    }
  });
</script>
```

## How it works
- `GET /api/sos?brand=&category=&market=&competitors=` →
  - **SerpApi Google Trends** (engine=`google_trends`, `today 12-m`, geo from market) → average interest per brand → relative Share of Search.
  - **Google autocomplete** (free) → real buyer questions in the category.
- Returns JSON the page renders into the leaderboard, share %, gap and question bank.

## Cost
- SerpApi: free 100 lookups/mo, then paid tiers. Each brand check = 1 SerpApi lookup. Autocomplete is free.

## Roadmap (not built yet)
- Competitor **auto-suggest** (currently you type rivals on the confirm step).
- **TikTok** search volume + the accurate absolute number (that's the MyTelescope layer, revealed on the call).
- Caching + rate-limit protection for higher traffic.
