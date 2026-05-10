/* Paper Explorer — static front-end
 * Zero backend. Calls Semantic Scholar Graph API directly from the browser
 * (CORS-allowed). For title queries it also hits arXiv Atom API; because
 * arXiv does not send CORS headers, we first try a same-origin serverless
 * function at /api/arxiv if deployed, and otherwise fall back to a public
 * CORS relay (r.jina.ai).
 */

const S2 = "https://api.semanticscholar.org/graph/v1";
const S2_FIELDS_PAPER =
  "paperId,title,year,abstract,venue,authors,externalIds,openAccessPdf,referenceCount,citationCount";
const S2_FIELDS_NEIGHBOR =
  "title,year,authors,externalIds,openAccessPdf,venue,abstract";

const $ = (id) => document.getElementById(id);
const statusEl = $("status");
const summaryEl = $("summary");
const gridEl = $("grid");
const refListEl = $("refList");
const citListEl = $("citList");
const refCountEl = $("refCount");
const citCountEl = $("citCount");

let state = { references: [], citations: [] };

// ---------- API key handling (optional) ----------
const KEY_STORAGE = "s2_api_key";
$("apikey").value = localStorage.getItem(KEY_STORAGE) || "";
$("saveKey").addEventListener("click", () => {
  const v = $("apikey").value.trim();
  if (v) localStorage.setItem(KEY_STORAGE, v);
  else localStorage.removeItem(KEY_STORAGE);
  setStatus(v ? "API Key 已保存（仅保存在本机浏览器）" : "已清除 API Key", "warn");
});

function s2Headers() {
  const k = localStorage.getItem(KEY_STORAGE);
  return k ? { "x-api-key": k } : {};
}

// ---------- tiny in-memory cache (per session) ----------
const cache = new Map();
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > 60 * 60 * 1000) { cache.delete(key); return null; }
  return v.value;
}
function cacheSet(key, value) { cache.set(key, { ts: Date.now(), value }); }

// ---------- input parsing ----------
function classify(raw) {
  const q = (raw || "").trim();
  if (!q) throw new Error("请输入论文信息");

  const doi = q.match(/10\.\d{4,9}\/[^\s"'<>]+/);
  if (doi) {
    const d = doi[0].replace(/[.,);\]]+$/, "");
    return { kind: "doi", id: d, s2: `DOI:${d}` };
  }

  const ax = q.match(/\b(\d{4}\.\d{4,5})(v\d+)?\b/);
  if (ax) return { kind: "arxiv", id: ax[1], s2: `arXiv:${ax[1]}` };

  const oldAx = q.match(/\b([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/);
  if (oldAx) return { kind: "arxiv", id: oldAx[1], s2: `arXiv:${oldAx[1]}` };

  if (/^[0-9a-f]{40}$/.test(q)) return { kind: "s2", id: q, s2: q };

  return { kind: "title", id: q, s2: null };
}

// ---------- low-level fetch with retry ----------
async function s2Get(path, params) {
  const url = new URL(S2 + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));

  let lastErr = "";
  for (let i = 0; i < 4; i++) {
    let resp;
    try {
      resp = await fetch(url, { headers: s2Headers() });
    } catch (e) {
      lastErr = e.message;
      await sleep(1000 + i * 1000);
      continue;
    }
    if (resp.status === 429) {
      lastErr = "429 rate limited";
      await sleep(1500 + i * 1500);
      continue;
    }
    if (!resp.ok) {
      const body = await resp.text();
      const hasKey = !!localStorage.getItem(KEY_STORAGE);
      const hint = resp.status === 403 && !hasKey
        ? "（可以在上方填入 Semantic Scholar API Key 后重试）" : "";
      throw new Error(`S2 ${resp.status}: ${body.slice(0, 140)} ${hint}`);
    }
    return await resp.json();
  }
  throw new Error(`Semantic Scholar 连不上或持续被限流（${lastErr}）。匿名接口大约 1 req/s，等 1~2 分钟再试；或填入 API Key。`);
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ---------- arXiv title search (fallback for title queries) ----------
async function arxivTitleLookup(title) {
  // Build arXiv Atom API URL
  const axUrl = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent('ti:"' + title + '"')}&max_results=1`;
  // Prefer same-origin serverless function (/api/arxiv?u=...) if deployed,
  // otherwise fall back to r.jina.ai (free CORS relay). Users can also
  // host their own relay; override via window.ARXIV_RELAY.
  const candidates = [];
  if (window.ARXIV_RELAY) candidates.push(window.ARXIV_RELAY + encodeURIComponent(axUrl));
  candidates.push("/api/arxiv?u=" + encodeURIComponent(axUrl));
  candidates.push("https://r.jina.ai/" + axUrl);

  for (const u of candidates) {
    try {
      const r = await fetch(u, { headers: { Accept: "application/atom+xml,text/plain" } });
      if (!r.ok) continue;
      const text = await r.text();
      const m = text.match(/http:\/\/arxiv\.org\/abs\/([\w.\-\/]+?)(?:v\d+)?</);
      if (m) return m[1];
    } catch { /* try next */ }
  }
  return null;
}

// ---------- resolve + fetch neighbours ----------
async function resolvePaper(input) {
  const meta = classify(input);
  const key = `resolve:${meta.kind}:${meta.id}`;
  const hit = cacheGet(key);
  if (hit) return hit;

  let paper;
  if (meta.kind === "title") {
    const ax = await arxivTitleLookup(meta.id);
    if (ax) {
      paper = await s2Get(`/paper/arXiv:${ax}`, { fields: S2_FIELDS_PAPER });
    } else {
      try {
        const data = await s2Get("/paper/search", { query: meta.id, limit: 1, fields: S2_FIELDS_PAPER });
        if (!data.data || !data.data.length) throw new Error(`未找到标题匹配: ${meta.id}`);
        paper = data.data[0];
      } catch (e) {
        if (String(e).includes("429") || String(e).includes("限流")) {
          throw new Error("Semantic Scholar 标题搜索被限流。请改用 arXiv ID / DOI，或填入 API Key。");
        }
        throw e;
      }
    }
  } else {
    paper = await s2Get(`/paper/${meta.s2}`, { fields: S2_FIELDS_PAPER });
  }
  cacheSet(key, paper);
  return paper;
}

async function fetchNeighbors(paperId, kind, limit = 100) {
  const key = `${kind}:${paperId}:${limit}`;
  const hit = cacheGet(key);
  if (hit) return hit;
  const data = await s2Get(`/paper/${paperId}/${kind}`, { fields: S2_FIELDS_NEIGHBOR, limit });
  const field = kind === "references" ? "citedPaper" : "citingPaper";
  const rows = (data.data || []).map((r) => enrich(r[field])).filter(Boolean);
  cacheSet(key, rows);
  return rows;
}

// ---------- enrich: turn a paper into a row with clickable links ----------
function enrich(p) {
  if (!p) return null;
  const ext = p.externalIds || {};
  const arxiv = ext.ArXiv;
  const doi = ext.DOI;
  const oa = (p.openAccessPdf || {}).url;

  const links = [];
  if (arxiv) {
    links.push({ label: "arXiv", url: `https://arxiv.org/abs/${arxiv}` });
    links.push({ label: "PDF (arXiv)", url: `https://arxiv.org/pdf/${arxiv}.pdf` });
  }
  if (doi && !doi.startsWith("10.48550/arXiv")) {
    links.push({ label: "DOI", url: `https://doi.org/${doi}` });
  }
  if (oa) links.push({ label: "Open PDF", url: oa });
  if (p.paperId) links.push({ label: "Semantic Scholar", url: `https://www.semanticscholar.org/paper/${p.paperId}` });
  if (p.title) links.push({
    label: "Google Scholar",
    url: `https://scholar.google.com/scholar?q=${encodeURIComponent(p.title)}`,
  });

  return {
    paperId: p.paperId,
    title: p.title,
    year: p.year,
    authors: (p.authors || []).map((a) => a.name).filter(Boolean),
    venue: p.venue,
    abstract: p.abstract,
    arxiv, doi, openPdf: oa, links,
  };
}

// ---------- UI ----------
function setStatus(msg, kind = "") {
  statusEl.textContent = msg || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
  statusEl.style.display = msg ? "block" : "none";
}
function esc(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function renderSummary(p) {
  if (!p) { summaryEl.innerHTML = ""; return; }
  const authors = (p.authors || []).join(", ");
  const badges = [];
  if (p.arxiv) badges.push(`<span class="badge primary">arXiv ${esc(p.arxiv)}</span>`);
  if (p.doi) badges.push(`<span class="badge">DOI: ${esc(p.doi)}</span>`);
  if (p.openPdf) badges.push(`<span class="badge success">Open PDF</span>`);
  badges.push(`<span class="badge">${esc(p.venue || "unknown venue")}</span>`);
  badges.push(`<span class="badge">refs: ${p.referenceCount ?? "-"}</span>`);
  badges.push(`<span class="badge">cited: ${p.citationCount ?? "-"}</span>`);

  const links = (p.links || []).map(
    (l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`
  ).join("");

  summaryEl.innerHTML = `
    <div class="paper-card">
      <div class="paper-title">${esc(p.title || "(untitled)")}</div>
      <div class="paper-meta">${esc(p.year || "")} · ${esc(authors)}</div>
      <div class="paper-badges">${badges.join("")}</div>
      <div class="paper-links">${links}</div>
      ${p.abstract ? `<div class="paper-abstract">${esc(p.abstract)}</div>` : ""}
    </div>`;
}

function renderList(container, items, kind) {
  if (!items.length) {
    container.innerHTML = `<div class="empty">暂无 ${kind === "ref" ? "引用" : "被引"} 数据</div>`;
    return;
  }
  container.innerHTML = items.map((p) => {
    const authors = (p.authors || []).slice(0, 5).join(", ") + ((p.authors || []).length > 5 ? ", …" : "");
    const linkHtml = (p.links || []).map((l) => {
      const cls = /pdf/i.test(l.label) ? "pdf" : "";
      return `<a class="${cls}" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`;
    }).join("");

    return `
      <div class="item">
        <div class="item-title">${esc(p.title || "(untitled)")}
          <span class="year">· ${esc(p.year || "")}</span>
        </div>
        <div class="item-authors">${esc(authors || "—")}${p.venue ? " · " + esc(p.venue) : ""}</div>
        <div class="item-links">${linkHtml}</div>
      </div>`;
  }).join("");
}

function applyFilter(inputId, listId, items, kind) {
  const q = $(inputId).value.trim().toLowerCase();
  const filtered = q
    ? items.filter((p) => ((p.title || "") + " " + (p.authors || []).join(" ")).toLowerCase().includes(q))
    : items;
  renderList($(listId), filtered, kind);
}

$("refFilter").addEventListener("input", () => applyFilter("refFilter", "refList", state.references, "ref"));
$("citFilter").addEventListener("input", () => applyFilter("citFilter", "citList", state.citations, "cit"));

$("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;
  $("searchBtn").disabled = true;
  setStatus("查询中…（匿名调用限流较严，请耐心等待）");
  summaryEl.innerHTML = "";
  gridEl.style.display = "none";
  refListEl.innerHTML = citListEl.innerHTML = "";
  try {
    const paper = await resolvePaper(q);
    if (!paper || !paper.paperId) throw new Error("Paper 无 Semantic Scholar ID");

    const [refs, cits] = await Promise.all([
      fetchNeighbors(paper.paperId, "references", 100),
      fetchNeighbors(paper.paperId, "citations", 100),
    ]);

    const enriched = enrich(paper);
    enriched.referenceCount = paper.referenceCount;
    enriched.citationCount = paper.citationCount;
    renderSummary(enriched);
    state = { references: refs, citations: cits };
    refCountEl.textContent = `${refs.length} 条`;
    citCountEl.textContent = `${cits.length} 条`;
    renderList(refListEl, refs, "ref");
    renderList(citListEl, cits, "cit");
    gridEl.style.display = "grid";
    setStatus("");
  } catch (err) {
    setStatus(`失败：${err.message}`, "error");
  } finally {
    $("searchBtn").disabled = false;
  }
});

// Auto-fill example if no query param. Use the ActCam paper the user specified.
const initQ = new URLSearchParams(location.search).get("q");
if (initQ) {
  $("q").value = initQ;
  $("searchForm").dispatchEvent(new Event("submit"));
} else {
  // Default placeholder: user can just hit Enter to try.
  $("q").placeholder = "arXiv:2605.06667 — ActCam: Zero-Shot Joint Camera and 3D Motion Control";
}
