/* Paper Explorer — app.js
 * Zero-backend. Calls Semantic Scholar Graph API directly (CORS-allowed).
 * Supports: arXiv ID / DOI / arXiv URL / S2 paperId / free-text title.
 * Features: dark/light theme toggle, zh/en i18n, responsive layout.
 * Author: 乐乐观
 */

// ── Constants ──────────────────────────────────────────────────────────────
const S2            = "https://api.semanticscholar.org/graph/v1";
const S2_FIELDS     = "paperId,title,year,abstract,venue,authors,externalIds,openAccessPdf,referenceCount,citationCount";
const S2_FIELDS_NBR = "title,year,authors,externalIds,openAccessPdf,venue,abstract";
const KEY_STORAGE   = "s2_api_key";
const LANG_STORAGE  = "pe_lang";
const THEME_STORAGE = "pe_theme";

// ── DOM refs ───────────────────────────────────────────────────────────────
const $  = (id) => document.getElementById(id);
const statusEl  = $("status");
const summaryEl = $("summary");
const gridEl    = $("grid");
const refListEl = $("refList");
const citListEl = $("citList");
const refCountEl = $("refCount");
const citCountEl = $("citCount");
const themeBtn  = $("themeBtn");
const langBtn   = $("langBtn");

let state = { references: [], citations: [] };

// ── Theme ──────────────────────────────────────────────────────────────────
const prefersDark = () => window.matchMedia("(prefers-color-scheme: dark)").matches;

function applyTheme(theme) {
  // theme: "light" | "dark" | "auto"
  const isDark = theme === "dark" || (theme === "auto" && prefersDark());
  document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
  themeBtn.textContent = isDark ? "Night" : "Day";
  localStorage.setItem(THEME_STORAGE, theme);
}

(function initTheme() {
  const saved = localStorage.getItem(THEME_STORAGE) || "auto";
  applyTheme(saved);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if ((localStorage.getItem(THEME_STORAGE) || "auto") === "auto") applyTheme("auto");
  });
})();

themeBtn.addEventListener("click", () => {
  const html = document.documentElement;
  const cur = html.getAttribute("data-theme");
  applyTheme(cur === "dark" ? "light" : "dark");
});

// ── i18n ───────────────────────────────────────────────────────────────────
let lang = localStorage.getItem(LANG_STORAGE) || "zh";

const I18N = {
  zh: {
    searching:   "查询中…（匿名调用限流较严，请耐心等待）",
    noId:        "Paper 无 Semantic Scholar ID",
    emptyRef:    "暂无引用数据",
    emptyCit:    "暂无被引数据",
    keySaved:    "API Key 已保存（仅保存在本机浏览器）",
    keyCleared:  "已清除 API Key",
    rateLimit:   "Semantic Scholar 标题搜索被限流。请改用 arXiv ID / DOI，或填入 API Key。",
    noMatch:     (q) => `未找到标题匹配：${q}`,
    s2Fail:      (e) => `Semantic Scholar 连不上或持续被限流（${e}）。匿名接口约 1 req/s，等 1~2 分钟再试；或填入 API Key。`,
    s2Err:       (s, b, hint) => `S2 ${s}: ${b} ${hint}`,
    s2ErrHint:   "（可在上方填入 Semantic Scholar API Key 后重试）",
    units:       "条",
  },
  en: {
    searching:   "Searching… (anonymous rate limit is strict, please wait)",
    noId:        "Paper has no Semantic Scholar ID",
    emptyRef:    "No references found",
    emptyCit:    "No citations found",
    keySaved:    "API Key saved (stored locally in your browser only)",
    keyCleared:  "API Key cleared",
    rateLimit:   "S2 title search rate-limited. Try arXiv ID / DOI, or add an API Key.",
    noMatch:     (q) => `No paper matched: ${q}`,
    s2Fail:      (e) => `Semantic Scholar unreachable (${e}). Anonymous ~1 req/s — wait 1-2 min or add API Key.`,
    s2Err:       (s, b, hint) => `S2 ${s}: ${b} ${hint}`,
    s2ErrHint:   "(Add a Semantic Scholar API Key above and retry)",
    units:       "",
  },
};

function t(key, ...args) {
  const v = I18N[lang][key];
  return typeof v === "function" ? v(...args) : v;
}

function applyLang(l) {
  lang = l;
  localStorage.setItem(LANG_STORAGE, l);
  langBtn.textContent = l === "zh" ? "中 / EN" : "EN / 中";
  document.documentElement.lang = l === "zh" ? "zh-CN" : "en";

  // Update all data-zh / data-en text nodes
  document.querySelectorAll("[data-zh]").forEach((el) => {
    el.textContent = l === "zh" ? el.dataset.zh : el.dataset.en;
  });
  // Update placeholders
  document.querySelectorAll("[data-zh-placeholder]").forEach((el) => {
    el.placeholder = l === "zh" ? el.dataset.zhPlaceholder : el.dataset.enPlaceholder;
  });
  // Re-render lists so counts / empty messages follow the new language
  if (state.references.length || state.citations.length) {
    refCountEl.textContent = fmtCount(state.references.length);
    citCountEl.textContent = fmtCount(state.citations.length);
  }
}

(function initLang() { applyLang(lang); })();

langBtn.addEventListener("click", () => applyLang(lang === "zh" ? "en" : "zh"));

// ── API Key ────────────────────────────────────────────────────────────────
$("apikey").value = localStorage.getItem(KEY_STORAGE) || "";

$("saveKey").addEventListener("click", () => {
  const v = $("apikey").value.trim();
  if (v) localStorage.setItem(KEY_STORAGE, v);
  else   localStorage.removeItem(KEY_STORAGE);
  setStatus(v ? t("keySaved") : t("keyCleared"));
});

function s2Headers() {
  const k = localStorage.getItem(KEY_STORAGE);
  return k ? { "x-api-key": k } : {};
}

// ── Cache ──────────────────────────────────────────────────────────────────
const cache = new Map();
function cacheGet(key) {
  const v = cache.get(key);
  if (!v) return null;
  if (Date.now() - v.ts > 3_600_000) { cache.delete(key); return null; }
  return v.value;
}
function cacheSet(key, value) { cache.set(key, { ts: Date.now(), value }); }

// ── Input parsing ──────────────────────────────────────────────────────────
function classify(raw) {
  const q = (raw || "").trim();
  if (!q) throw new Error(lang === "zh" ? "请输入论文信息" : "Please enter a paper identifier");

  // DOI first (avoids false arXiv match on e.g. 10.1145/3726302.3730046)
  const doi = q.match(/10\.\d{4,9}\/[^\s"'<>]+/);
  if (doi) {
    const d = doi[0].replace(/[.,);\]]+$/, "");
    return { kind: "doi", id: d, s2: `DOI:${d}` };
  }
  // arXiv new-style
  const ax = q.match(/\b(\d{4}\.\d{4,5})(v\d+)?\b/);
  if (ax) return { kind: "arxiv", id: ax[1], s2: `arXiv:${ax[1]}` };
  // arXiv old-style
  const oldAx = q.match(/\b([a-z\-]+(?:\.[A-Z]{2})?\/\d{7})(v\d+)?\b/);
  if (oldAx) return { kind: "arxiv", id: oldAx[1], s2: `arXiv:${oldAx[1]}` };
  // S2 paperId (40-char hex)
  if (/^[0-9a-f]{40}$/.test(q)) return { kind: "s2", id: q, s2: q };
  // fallback: title
  return { kind: "title", id: q, s2: null };
}

// ── Fetch helpers ──────────────────────────────────────────────────────────
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function s2Get(path, params) {
  const url = new URL(S2 + path);
  if (params) Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  let lastErr = "";
  for (let i = 0; i < 4; i++) {
    let resp;
    try { resp = await fetch(url, { headers: s2Headers() }); }
    catch (e) { lastErr = e.message; await sleep(1000 + i * 1000); continue; }
    if (resp.status === 429) { lastErr = "429"; await sleep(1500 + i * 1500); continue; }
    if (!resp.ok) {
      const body = await resp.text();
      const hint = resp.status === 403 && !localStorage.getItem(KEY_STORAGE)
        ? t("s2ErrHint") : "";
      throw new Error(t("s2Err", resp.status, body.slice(0, 120), hint));
    }
    return await resp.json();
  }
  throw new Error(t("s2Fail", lastErr));
}

// arXiv title lookup (CORS relay chain)
async function arxivTitleLookup(title) {
  const axUrl = `https://export.arxiv.org/api/query?search_query=${encodeURIComponent(`ti:"${title}"`)}&max_results=1`;
  const relays = [
    ...(window.ARXIV_RELAY ? [window.ARXIV_RELAY + encodeURIComponent(axUrl)] : []),
    "/api/arxiv?u=" + encodeURIComponent(axUrl),
    "https://r.jina.ai/" + axUrl,
  ];
  for (const u of relays) {
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

// ── Paper resolution ───────────────────────────────────────────────────────
async function resolvePaper(input) {
  const meta = classify(input);
  const ckey = `resolve:${meta.kind}:${meta.id}`;
  const hit = cacheGet(ckey);
  if (hit) return hit;

  let paper;
  if (meta.kind === "title") {
    const ax = await arxivTitleLookup(meta.id);
    if (ax) {
      paper = await s2Get(`/paper/arXiv:${ax}`, { fields: S2_FIELDS });
    } else {
      try {
        const data = await s2Get("/paper/search", { query: meta.id, limit: 1, fields: S2_FIELDS });
        if (!data.data?.length) throw new Error(t("noMatch", meta.id));
        paper = data.data[0];
      } catch (e) {
        if (String(e).includes("429") || String(e).includes("限流") || String(e).includes("rate")) {
          throw new Error(t("rateLimit"));
        }
        throw e;
      }
    }
  } else {
    paper = await s2Get(`/paper/${meta.s2}`, { fields: S2_FIELDS });
  }
  cacheSet(ckey, paper);
  return paper;
}

async function fetchNeighbors(paperId, kind, limit = 100) {
  const ckey = `${kind}:${paperId}:${limit}`;
  const hit = cacheGet(ckey);
  if (hit) return hit;
  const data = await s2Get(`/paper/${paperId}/${kind}`, { fields: S2_FIELDS_NBR, limit });
  const field = kind === "references" ? "citedPaper" : "citingPaper";
  const rows = (data.data || []).map((r) => enrich(r[field])).filter(Boolean);
  cacheSet(ckey, rows);
  return rows;
}

// ── Enrich paper object ────────────────────────────────────────────────────
function enrich(p) {
  if (!p) return null;
  const ext   = p.externalIds || {};
  const arxiv = ext.ArXiv;
  const doi   = ext.DOI;
  const oa    = (p.openAccessPdf || {}).url;

  const links = [];
  if (arxiv) {
    links.push({ label: "arXiv",      url: `https://arxiv.org/abs/${arxiv}` });
    links.push({ label: "PDF",        url: `https://arxiv.org/pdf/${arxiv}.pdf`, pdf: true });
  }
  if (doi && !doi.startsWith("10.48550/arXiv")) {
    links.push({ label: "DOI", url: `https://doi.org/${doi}` });
  }
  if (oa) links.push({ label: "Open PDF", url: oa, pdf: true });
  if (p.paperId) links.push({ label: "S2", url: `https://www.semanticscholar.org/paper/${p.paperId}` });
  if (p.title)   links.push({ label: "GScholar", url: `https://scholar.google.com/scholar?q=${encodeURIComponent(p.title)}` });

  return {
    paperId: p.paperId,
    title:   p.title,
    year:    p.year,
    authors: (p.authors || []).map((a) => a.name).filter(Boolean),
    venue:   p.venue,
    abstract: p.abstract,
    arxiv, doi, openPdf: oa,
    referenceCount: p.referenceCount,
    citationCount:  p.citationCount,
    links,
  };
}

// ── Render helpers ─────────────────────────────────────────────────────────
function esc(s) {
  if (s == null) return "";
  return String(s).replace(/[&<>"']/g,
    (c) => ({ "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;" }[c]));
}

function setStatus(msg, kind = "") {
  statusEl.textContent = msg || "";
  statusEl.className   = "status" + (kind ? " " + kind : "");
  statusEl.style.display = msg ? "block" : "none";
}

function fmtCount(n) {
  if (n == null) return "";
  return lang === "zh" ? `共 ${n} 篇` : `${n} items`;
}

function renderSummary(p) {
  if (!p) { summaryEl.innerHTML = ""; return; }
  const authors = (p.authors || []).join(", ");

  // facts: inline key/value labels, no pills
  const facts = [];
  if (p.arxiv)   facts.push(`<span class="fact-accent"><b>arXiv</b> ${esc(p.arxiv)}</span>`);
  if (p.doi)     facts.push(`<span><b>DOI</b> ${esc(p.doi)}</span>`);
  if (p.venue)   facts.push(`<span><b>Venue</b> ${esc(p.venue)}</span>`);
  if (p.year)    facts.push(`<span><b>Year</b> ${esc(p.year)}</span>`);
  facts.push(`<span><b>Refs</b> ${p.referenceCount ?? "—"}</span>`);
  facts.push(`<span><b>Cited</b> ${p.citationCount ?? "—"}</span>`);
  if (p.openPdf) facts.push(`<span class="fact-ok"><b>Open PDF</b> ✓</span>`);

  const links = (p.links || []).map(
    (l) => `<a href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`
  ).join("");

  const eyebrow = lang === "zh" ? "检索到" : "Paper Found";

  summaryEl.innerHTML = `
    <article class="paper">
      <div class="paper-eyebrow">${eyebrow}</div>
      <h2>${esc(p.title || "(untitled)")}</h2>
      ${authors ? `<div class="byline">by ${esc(authors)}</div>` : ""}
      <div class="facts">${facts.join("")}</div>
      <div class="links">${links}</div>
      ${p.abstract ? `<div class="abstract">${esc(p.abstract)}</div>` : ""}
    </article>`;
}

function renderList(container, items, kind) {
  if (!items.length) {
    container.innerHTML = `<div class="empty">${kind === "ref" ? t("emptyRef") : t("emptyCit")}</div>`;
    return;
  }
  container.innerHTML = items.map((p) => {
    const authors = (p.authors || []).slice(0, 4).join(", ")
      + ((p.authors || []).length > 4 ? ", et al." : "");
    const meta = [authors, p.venue].filter(Boolean).map(esc).join(" · ");
    const linkHtml = (p.links || []).map((l) =>
      `<a class="${l.pdf ? "pdf" : ""}" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.label)}</a>`
    ).join("");
    return `
      <div class="entry">
        <div class="entry-title">${esc(p.title || "(untitled)")}<span class="year">· ${esc(p.year || "")}</span></div>
        <div class="entry-meta">${meta || "—"}</div>
        <div class="entry-links">${linkHtml}</div>
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

// ── Search form ────────────────────────────────────────────────────────────
$("searchForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const q = $("q").value.trim();
  if (!q) return;

  $("searchBtn").disabled = true;
  setStatus(t("searching"));
  summaryEl.innerHTML = "";
  gridEl.style.display = "none";
  refListEl.innerHTML = citListEl.innerHTML = "";

  try {
    const paper = await resolvePaper(q);
    if (!paper?.paperId) throw new Error(t("noId"));

    const [refs, cits] = await Promise.all([
      fetchNeighbors(paper.paperId, "references", 100),
      fetchNeighbors(paper.paperId, "citations",  100),
    ]);

    const enriched = enrich(paper);
    renderSummary(enriched);

    state = { references: refs, citations: cits };
    refCountEl.textContent = fmtCount(refs.length);
    citCountEl.textContent = fmtCount(cits.length);
    renderList(refListEl, refs, "ref");
    renderList(citListEl, cits, "cit");
    gridEl.style.display = "grid";
    setStatus("");
  } catch (err) {
    setStatus(err.message, "error");
  } finally {
    $("searchBtn").disabled = false;
  }
});

// ── Example chip click ─────────────────────────────────────────────────────
window.fillAndSearch = function(q) {
  $("q").value = q;
  $("searchForm").dispatchEvent(new Event("submit"));
};

// ── Dateline (small typographic flourish) ──────────────────────────────────
(function setDateline() {
  const el = document.getElementById("dateline");
  if (!el) return;
  const now = new Date();
  const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
  el.textContent = `${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
})();

// ── URL ?q= auto-run ───────────────────────────────────────────────────────
const initQ = new URLSearchParams(location.search).get("q");
if (initQ) {
  $("q").value = initQ;
  $("searchForm").dispatchEvent(new Event("submit"));
}

// ── Intro modal ────────────────────────────────────────────────────────────
const MODAL_STORAGE = "pe_intro_seen";
const introModal    = $("introModal");
const introClose    = $("introClose");
const introStart    = $("introStart");
const introDontShow = $("introDontShow");
const helpBtn       = $("helpBtn");

function openIntro() {
  // Re-apply translations in case lang changed since load
  introModal.querySelectorAll("[data-zh]").forEach((el) => {
    el.textContent = lang === "zh" ? el.dataset.zh : el.dataset.en;
  });
  introModal.classList.add("show");
  document.body.style.overflow = "hidden";
}
function closeIntro() {
  introModal.classList.remove("show");
  document.body.style.overflow = "";
  if (introDontShow.checked) {
    localStorage.setItem(MODAL_STORAGE, "1");
  } else {
    localStorage.removeItem(MODAL_STORAGE);
  }
}

introClose.addEventListener("click", closeIntro);
introStart.addEventListener("click", () => { closeIntro(); $("q").focus(); });
introModal.addEventListener("click", (e) => {
  if (e.target === introModal) closeIntro();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && introModal.classList.contains("show")) closeIntro();
});
helpBtn.addEventListener("click", () => {
  // Reset "don't show again" so user can re-enable reminder if they want
  introDontShow.checked = localStorage.getItem(MODAL_STORAGE) === "1";
  openIntro();
});

// First visit: open automatically unless suppressed or arriving via ?q=
if (!initQ && !localStorage.getItem(MODAL_STORAGE)) {
  // Delay a hair so theme/lang are applied first
  setTimeout(openIntro, 150);
}
