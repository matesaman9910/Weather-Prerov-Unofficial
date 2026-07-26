// Meteoalarm Czechia proxy v4.
// Strict regional filtering uses CAP areaDesc and EMMA_ID geocodes.

const APP_VERSION = "2026-07-26.v4";
const FEED_URL = "https://feeds.meteoalarm.org/feeds/meteoalarm-legacy-atom-czechia";
const CACHE_TTL_SECONDS = 600;
const MAX_FEED_BYTES = 2_000_000;

const REGIONS = Object.freeze({
  praha: { prefix: "CZ010", tokens: ["praha", "prague"] },
  stredocesky: { prefix: "CZ020", tokens: ["stredocesk"] },
  jihocesky: { prefix: "CZ031", tokens: ["jihocesk"] },
  plzensky: { prefix: "CZ032", tokens: ["plzensk"] },
  karlovarsky: { prefix: "CZ041", tokens: ["karlovarsk"] },
  ustecky: { prefix: "CZ042", tokens: ["usteck"] },
  liberecky: { prefix: "CZ051", tokens: ["libereck"] },
  kralovehradecky: { prefix: "CZ052", tokens: ["kralovehradeck"] },
  pardubicky: { prefix: "CZ053", tokens: ["pardubick"] },
  vysocina: { prefix: "CZ063", tokens: ["vysocin"] },
  jihomoravsky: { prefix: "CZ064", tokens: ["jihomoravsk", "south moravian"] },
  olomoucky: { prefix: "CZ071", tokens: ["olomouck", "olomouc region", "prerov"] },
  zlinsky: { prefix: "CZ072", tokens: ["zlinsk"] },
  moravskoslezsky: { prefix: "CZ080", tokens: ["moravskoslezsk", "ostrava"] },
});

let lastDebug = {
  when: null,
  status: null,
  variant: null,
  message: "No upstream request has completed in this isolate.",
  bytes: null,
  entries: null,
};

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method !== "GET") {
      return json({ ok: false, error: "method-not-allowed" }, 405, {
        Allow: "GET, OPTIONS",
      });
    }

    if (url.pathname === "/") {
      return json({
        ok: true,
        service: "meteoalarm-cz-proxy",
        version: APP_VERSION,
        now: new Date().toISOString(),
        endpoints: ["/meteoalarm-cz?region=olomoucky", "/debug"],
        supportedRegions: Object.keys(REGIONS),
      });
    }

    if (url.pathname === "/debug") {
      return json({ ok: true, version: APP_VERSION, lastDebug }, 200, {
        "cache-control": "no-store",
      });
    }

    if (url.pathname !== "/meteoalarm-cz") {
      return json({ ok: false, error: "not-found" }, 404);
    }

    const region = normalizeRegion(url.searchParams.get("region") || "olomoucky");
    if (!REGIONS[region]) {
      return json({
        ok: false,
        error: "unsupported-region",
        supportedRegions: Object.keys(REGIONS),
      }, 400, { "cache-control": "no-store" });
    }

    const cache = caches.default;
    const cacheKey = new Request(
      `${url.origin}/__meteoalarm-cache?region=${encodeURIComponent(region)}`,
      { method: "GET" },
    );
    const cached = await cache.match(cacheKey);
    if (cached) return withCors(cached);

    const upstream = await fetchFeedRobust();
    if (!upstream.ok) {
      return json({
        ok: false,
        error: upstream.error || "feed-error",
      }, upstream.status || 502, { "cache-control": "no-store" });
    }

    let allItems;
    try {
      allItems = parseFeed(upstream.body);
    } catch (error) {
      return json({
        ok: false,
        error: "invalid-feed",
        message: error instanceof Error ? error.message : String(error),
      }, 502, { "cache-control": "no-store" });
    }

    const items = filterRegionItems(allItems, region, new Date());
    const response = json({
      ok: true,
      version: APP_VERSION,
      region,
      regionVerified: true,
      count: items.length,
      bestLevel: rank(items.map((item) => item.level)),
      items: items.slice(0, 20),
    }, 200, {
      "cache-control": `public, max-age=${CACHE_TTL_SECONDS}`,
      "x-worker-version": APP_VERSION,
    });

    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};

export function stripDiacritics(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}

export function normalizeRegion(value) {
  const normalized = stripDiacritics(value).toLowerCase().replace(/[^a-z]/g, "");
  const aliases = [
    ["moravskoslez", "moravskoslezsky"],
    ["jihomorav", "jihomoravsky"],
    ["kralovehrade", "kralovehradecky"],
    ["karlovar", "karlovarsky"],
    ["stredocesk", "stredocesky"],
    ["olomouc", "olomoucky"],
    ["pardubic", "pardubicky"],
    ["liberec", "liberecky"],
    ["jihocesk", "jihocesky"],
    ["plzen", "plzensky"],
    ["usteck", "ustecky"],
    ["vysocin", "vysocina"],
    ["zlinsk", "zlinsky"],
    ["praha", "praha"],
    ["prague", "praha"],
  ];
  return aliases.find(([needle]) => normalized.includes(needle))?.[1] || normalized;
}

export function parseFeed(xml) {
  if (typeof xml !== "string" || !/<feed(?:\s|>)/i.test(xml)) {
    throw new TypeError("Meteoalarm response is not an Atom feed");
  }
  return [...xml.matchAll(/<entry(?:\s[^>]*)?>[\s\S]*?<\/entry>/gi)]
    .map((match) => parseEntry(match[0]))
    .filter((item) => item.title);
}

export function parseEntry(entryXml) {
  const effective = pickIso(tagText(entryXml, "effective"));
  const onset = pickIso(tagText(entryXml, "onset"));
  return {
    id: tagText(entryXml, "id") || tagText(entryXml, "identifier") || null,
    title: tagText(entryXml, "title"),
    event: tagText(entryXml, "event") || null,
    area: tagText(entryXml, "areaDesc") || null,
    level: mapSeverity(
      tagText(entryXml, "severity")
      || attributeValue(entryXml, "awarenessLevel", "value")
      || tagText(entryXml, "awareness_level"),
    ),
    effective,
    starts: onset || effective,
    expires: pickIso(tagText(entryXml, "expires")),
    updated: pickIso(tagText(entryXml, "updated")),
    geocodes: parseGeocodes(entryXml),
  };
}

export function filterRegionItems(items, region, now = new Date()) {
  const definition = REGIONS[region];
  if (!definition) return [];
  const nowMs = now.getTime();
  const unique = new Map();

  for (const item of Array.isArray(items) ? items : []) {
    if (!matchesRegion(item, definition)) continue;
    const expiresMs = item.expires ? Date.parse(item.expires) : Number.POSITIVE_INFINITY;
    const updatedMs = item.updated ? Date.parse(item.updated) : Number.NEGATIVE_INFINITY;
    if (Number.isFinite(expiresMs) && expiresMs <= nowMs) continue;
    if (!item.expires && Number.isFinite(updatedMs) && nowMs - updatedMs > 24 * 60 * 60 * 1000) {
      continue;
    }

    const verified = {
      ...item,
      region,
      regionVerified: true,
    };
    const key = [
      normalizeText(item.title),
      normalizeText(item.area),
      item.starts || item.effective || "",
      item.expires || "",
      item.level,
    ].join("|");
    if (!unique.has(key)) unique.set(key, verified);
  }

  return [...unique.values()].sort((a, b) => {
    const severityDifference = severityScore(b.level) - severityScore(a.level);
    if (severityDifference) return severityDifference;
    return String(a.starts || a.effective || "").localeCompare(String(b.starts || b.effective || ""));
  });
}

export function matchesRegion(item, definition) {
  const geocodes = Array.isArray(item?.geocodes) ? item.geocodes : [];
  if (geocodes.some(({ name, value }) => (
    String(name || "").toUpperCase() === "EMMA_ID"
    && String(value || "").toUpperCase().startsWith(definition.prefix)
  ))) {
    return true;
  }

  const areaText = normalizeText(item?.area);
  const titleText = normalizeText(item?.title);
  return definition.tokens.some((token) => {
    const normalizedToken = normalizeText(token);
    return areaText.includes(normalizedToken) || titleText.includes(normalizedToken);
  });
}

export function mapSeverity(value = "") {
  const normalized = String(value).toLowerCase();
  if (/extreme|red|\b4\b/.test(normalized)) return "red";
  if (/severe|orange|\b3\b/.test(normalized)) return "orange";
  if (/moderate|yellow|\b2\b/.test(normalized)) return "yellow";
  if (/minor|green|\b1\b/.test(normalized)) return "green";
  return "yellow";
}

export function rank(levels) {
  const highest = (Array.isArray(levels) ? levels : [])
    .reduce((best, level) => Math.max(best, severityScore(level)), 0);
  return ["green", "green", "yellow", "orange", "red"][highest] || "green";
}

async function fetchFeedRobust() {
  const variants = [
    {
      name: "atom",
      headers: {
        Accept: "application/atom+xml, application/xml;q=0.9, */*;q=0.8",
        "User-Agent": "MeteoalarmProxy/4.0 (+https://github.com/matesaman9910/Weather-Prerov-Unofficial)",
      },
    },
    {
      name: "wildcard",
      headers: {
        Accept: "*/*",
        "User-Agent": "Mozilla/5.0 (compatible; MeteoalarmProxy/4.0)",
      },
    },
  ];

  for (const variant of variants) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8_000);
    try {
      const response = await fetch(FEED_URL, {
        headers: variant.headers,
        signal: controller.signal,
        cf: { cacheTtl: 0 },
      });
      const body = await response.text();
      lastDebug = {
        when: new Date().toISOString(),
        status: response.status,
        variant: variant.name,
        message: response.ok ? "ok" : `upstream-http-${response.status}`,
        bytes: body.length,
        entries: response.ok ? (body.match(/<entry(?:\s|>)/gi) || []).length : null,
      };
      if (body.length > MAX_FEED_BYTES) {
        return { ok: false, status: 502, error: "feed-too-large" };
      }
      if (response.ok) return { ok: true, body };
      if (response.status !== 406) {
        return { ok: false, status: response.status, error: `feed-http-${response.status}` };
      }
    } catch (error) {
      lastDebug = {
        when: new Date().toISOString(),
        status: null,
        variant: variant.name,
        message: error?.name === "AbortError" ? "upstream-timeout" : "upstream-fetch-failed",
        bytes: null,
        entries: null,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
  return { ok: false, status: 502, error: "feed-unavailable-after-retries" };
}

function tagText(xml, tagName) {
  const escaped = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = xml.match(
    new RegExp(`<(?:[\\w-]+:)?${escaped}(?:\\s[^>]*)?>([\\s\\S]*?)<\\/(?:[\\w-]+:)?${escaped}>`, "i"),
  );
  return match ? cleanXmlText(match[1]) : "";
}

function attributeValue(xml, tagName, attributeName) {
  const tag = tagName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const attribute = attributeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return xml.match(
    new RegExp(`<(?:[\\w-]+:)?${tag}\\b[^>]*\\b${attribute}=["']([^"']+)["']`, "i"),
  )?.[1] || "";
}

function parseGeocodes(xml) {
  return [...xml.matchAll(
    /<(?:[\w-]+:)?geocode(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?geocode>/gi,
  )].map((match) => ({
    name: tagText(match[1], "valueName"),
    value: tagText(match[1], "value"),
  })).filter(({ name, value }) => name && value);
}

function cleanXmlText(value) {
  return decodeXmlEntities(
    String(value || "")
      .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim(),
  );
}

function decodeXmlEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, decimal) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&");
}

function pickIso(value) {
  if (!value) return null;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizeText(value) {
  return stripDiacritics(value).toLowerCase().replace(/\s+/g, " ").trim();
}

function severityScore(level) {
  return { green: 1, yellow: 2, orange: 3, red: 4 }[level] || 0;
}

function corsHeaders() {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET, OPTIONS",
    "access-control-allow-headers": "Content-Type, Accept",
  };
}

function withCors(response) {
  const headers = new Headers(response.headers);
  Object.entries(corsHeaders()).forEach(([name, value]) => headers.set(name, value));
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function json(value, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      ...corsHeaders(),
      "content-type": "application/json; charset=utf-8",
      ...extraHeaders,
    },
  });
}

