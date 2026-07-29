const cheerio = require("cheerio");

function extract(html, sourceUrl) {
  const $ = cheerio.load(html);
  const base = new URL(sourceUrl).origin;
  const result = {};

  // ── Business Name ──────────────────────────────────────────────────────────
  result.businessName =
    $("meta[property='og:site_name']").attr("content") ||
    $("meta[property='og:title']").attr("content") ||
    $("h1").first().text().trim() ||
    $("title").text().replace(/[-|–|·].*/,"").trim() ||
    "";

  // ── Phone ──────────────────────────────────────────────────────────────────
  const telLink = $("a[href^='tel:']").first().attr("href");
  if (telLink) {
    result.phone = telLink.replace("tel:","").trim();
  } else {
    const m = $("body").text().match(/(\+?\d[\d\s\-().]{7,}\d)/);
    if (m) result.phone = m[1].trim();
  }

  // ── Email ──────────────────────────────────────────────────────────────────
  const mailLink = $("a[href^='mailto:']").first().attr("href");
  if (mailLink) {
    result.email = mailLink.replace("mailto:","").split("?")[0].trim();
  } else {
    const m = $("body").text().match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/);
    if (m) result.email = m[0];
  }

  // ── WhatsApp ───────────────────────────────────────────────────────────────
  const waLink = $("a[href*='wa.me'], a[href*='whatsapp.com/send']").first().attr("href");
  if (waLink) {
    const m = waLink.match(/wa\.me\/(\d+)/);
    if (m) result.whatsapp = "+" + m[1];
  }

  // ── Website ────────────────────────────────────────────────────────────────
  result.website =
    $("link[rel='canonical']").attr("href") ||
    $("meta[property='og:url']").attr("content") ||
    sourceUrl;

  // ── Logo ───────────────────────────────────────────────────────────────────
  // Priority: og:image → apple-touch-icon → img with logo in src/class/id
  // → header/navbar img → .logo/.brand/.site-logo img → first header img
  const ogImage   = $("meta[property='og:image']").attr("content");
  const touchIcon = $("link[rel='apple-touch-icon']").attr("href");

  // Search for logo image by common patterns
  const logoSelectors = [
    "img[src*='logo']", "img[class*='logo']", "img[id*='logo']",
    "img[class*='brand']", "img[class*='site-logo']", "img[alt*='logo']",
    "header img", "nav img", ".navbar img", ".header img",
    ".logo img", ".brand img", ".site-logo img",
  ];
  let logoImg = "";
  for (const sel of logoSelectors) {
    const src = $(sel).first().attr("src");
    if (src) { logoImg = src; break; }
  }

  const rawLogo = ogImage || touchIcon || logoImg || "";
  if (rawLogo) {
    result.logo = rawLogo.startsWith("http") ? rawLogo : base + "/" + rawLogo.replace(/^\//,"");
  }

  // ── Working Hours ──────────────────────────────────────────────────────────
  const hoursPatterns = [
    /(?:open|hours?|timing)[^\n.]{0,60}(?:am|pm|\d{1,2}:\d{2})/i,
    /(?:mon|tue|wed|thu|fri|sat|sun)[^\n.]{0,60}(?:am|pm|\d{1,2}:\d{2})/i,
    /\d{1,2}(?::\d{2})?\s*(?:am|pm)\s*[-–to]+\s*\d{1,2}(?::\d{2})?\s*(?:am|pm)/i,
  ];
  const fullText = $("body").text().replace(/\s+/g," ");
  for (const p of hoursPatterns) {
    const m = fullText.match(p);
    if (m) { result.workingHours = m[0].trim(); break; }
  }

  // ── Services ───────────────────────────────────────────────────────────────
  const serviceHeadings = ["services","our services","what we offer","menu","offerings","products","what we do","specialities"];
  let services = [];

  $("h1,h2,h3,h4").each((_, el) => {
    if (services.length) return false;
    const heading = $(el).text().toLowerCase().trim();
    if (serviceHeadings.some(s => heading.includes(s))) {
      const next = $(el).nextAll("ul,ol,p").first();
      if (next.is("ul,ol")) {
        next.find("li").each((_, li) => {
          const t = $(li).text().trim();
          if (t && t.length < 60) services.push(t);
        });
      } else if (next.is("p")) {
        services = next.text().split(/[,\n]/).map(s => s.trim()).filter(s => s.length > 1 && s.length < 60);
      }
    }
  });

  if (!services.length) {
    $("nav a,.menu a,.services li,.offerings li").each((_, el) => {
      const t = $(el).text().trim();
      if (t && t.length > 2 && t.length < 40 && !services.includes(t)) services.push(t);
    });
  }

  if (services.length) result.services = services.slice(0, 15);

  // ── Address ────────────────────────────────────────────────────────────────
  const addrEl = $("[class*='address'],[id*='address'],address").first();
  if (addrEl.length) result.address = addrEl.text().replace(/\s+/g," ").trim();

  return result;
}

/**
 * Merge results from multiple pages.
 * First extract (homepage) wins for scalar fields. Later pages fill gaps.
 * Services are combined and deduplicated.
 */
function mergeExtracts(extracts) {
  const merged = {};
  for (const data of extracts) {
    for (const [key, val] of Object.entries(data)) {
      if (key === "services") {
        const existing = merged.services || [];
        const incoming = Array.isArray(val) ? val : [];
        merged.services = [...new Set([...existing, ...incoming])].slice(0, 20);
      } else {
        const isEmpty = !merged[key] ||
          (Array.isArray(merged[key]) && merged[key].length === 0) ||
          merged[key] === "";
        if (isEmpty && val) merged[key] = val;
      }
    }
  }
  return merged;
}

/**
 * Try to fetch sitemap.xml and extract page URLs from it.
 * Returns array of URLs or empty array if sitemap not found.
 */
async function getSitemapUrls(baseUrl, fetchFn) {
  const sitemapUrl = new URL(baseUrl).origin + "/sitemap.xml";
  try {
    const xml = await fetchFn(sitemapUrl);
    const matches = [...xml.matchAll(/<loc>([^<]+)<\/loc>/gi)].map(m => m[1].trim());
    // Filter to useful pages only — skip images, PDFs, etc.
    const useful = matches.filter(u =>
      !u.match(/\.(jpg|jpeg|png|gif|pdf|zip|xml)$/i) &&
      u.startsWith(new URL(baseUrl).origin)
    );
    return useful.slice(0, 9); // cap at 9 pages from sitemap (+ homepage = 10 max)
  } catch {
    return []; // sitemap doesn't exist or failed — not an error
  }
}

module.exports = { extract, mergeExtracts, getSitemapUrls };
