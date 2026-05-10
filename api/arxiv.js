// Optional Vercel / Netlify serverless function that proxies arXiv's
// Atom API so browsers can use it without running into CORS issues.
// Path: /api/arxiv?u=<full arxiv API url>
//
// Deploy: drop this whole folder to Vercel — the function will be picked
// up automatically. If you prefer pure static hosting (no function),
// the front-end will fall back to https://r.jina.ai/... automatically.

export default async function handler(req, res) {
  const raw = (req.query && req.query.u) || "";
  if (!raw || !/^https?:\/\/export\.arxiv\.org\//.test(raw)) {
    res.status(400).json({ error: "missing or invalid 'u' — must start with https://export.arxiv.org/" });
    return;
  }
  try {
    const r = await fetch(raw, { headers: { "User-Agent": "paper-explorer/0.1" } });
    const text = await r.text();
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Content-Type", r.headers.get("content-type") || "application/atom+xml");
    res.setHeader("Cache-Control", "public, max-age=3600");
    res.status(r.status).send(text);
  } catch (e) {
    res.status(502).json({ error: String(e) });
  }
}
