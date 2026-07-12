// =============================================
// Terabox Direct Link Extractor + Player — FINAL
// Cloudflare Workers Script
//
// Features:
//   ✅ Accepts full link OR bare surl/ID
//   ✅ HLS streaming (360p/480p/720p/1080p) via share/streaming
//   ✅ Direct download link
//   ✅ Folder support (recursive)
//   ✅ Built-in HTML player (/play) with HLS.js + quality switch
//   ✅ JSON API (/api)
//   ✅ 2hr in-memory cache + CORS
//
// ENV VARIABLES (Cloudflare → Settings → Variables → Secrets):
//   NDUS        → ndus cookie value        (RECOMMENDED — your own account,
//                                            most reliable. If unset, or if
//                                            it fails, requests automatically
//                                            fall back to a shared public
//                                            cookie pool fetched from
//                                            tera.backend.live/cookies-list —
//                                            ported from terabox-auto-cookie.js)
//   CSRF_TOKEN  → csrfToken cookie value   (OPTIONAL — improves HLS reliability with your own NDUS)
//   BROWSER_ID  → browserid cookie value   (OPTIONAL — improves HLS reliability with your own NDUS)
//   NDUT_FMT    → ndut_fmt cookie value    (OPTIONAL — device/verification cookie)
//   TSID        → TSID cookie value        (OPTIONAL — session cookie)
//   RATE_LIMIT  → requests per IP per window (OPTIONAL — default 30, set 0 to disable)
//   RATE_WINDOW → rate-limit window in seconds (OPTIONAL — default 60)
//   CACHE_MAX_SIZE → max cached resolved-links entries (OPTIONAL — default 500)
//
// USAGE:
//   GET /api?url=https://1024terabox.com/s/SURL   → JSON
//   GET /api?url=SURL_ONLY                         → JSON (bare ID works too)
//   GET /play?url=SURL_OR_LINK                     → HTML player
//   GET /download?url=SURL_OR_LINK                 → direct file download (redirect)
//   POST /api  body: { "url": "..." }
// =============================================

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const CACHE_TTL = 2 * 60 * 60 * 1000; // 2 hours
const cache = new Map();

// Expired entries were previously only ever skipped-on-read, never removed —
// on a long-lived Worker isolate handling many different links, that Map
// grows forever and never releases memory. Sweep expired keys out whenever
// we're about to add a new one, so the cache stays bounded to roughly
// "entries added in the last CACHE_TTL window" instead of "every entry ever
// added since the isolate started". Also caps total size (ported from
// terabox-apis-main's cache.py CACHE_MAX_SIZE) — evicts the oldest entries
// (Map preserves insertion order) if a burst of unique links is resolved
// faster than the TTL naturally clears them out.
function pruneExpiredCache(env = {}) {
  const now = Date.now();
  for (const [key, val] of cache) {
    if (now >= val.expiry) cache.delete(key);
  }
  const maxSize = Number(env.CACHE_MAX_SIZE || 500);
  while (cache.size > maxSize) {
    const oldestKey = cache.keys().next().value;
    if (oldestKey === undefined) break;
    cache.delete(oldestKey);
  }
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

// ── Supported Domains ─────────────────────────────────────────────────────────

const TERABOX_DOMAINS = [
  "1024tera.com","1024terabox.com","terabox.app","teraboxapp.com",
  "www.terabox.com","dm.terabox.app","terabox.fun","terasharefile.com",
  "terasharelink.com","teraboxlink.com","mirrobox.com","nephobox.com",
  "freeterabox.com","4funbox.com","tibibox.com","tobybox.com",
  "momerybox.com","jobebox.com","gibibox.com","gomafiles.com",
  "boxlinks.net","terabox.club","terabox.site","terabox.online",
  "terabox.live","teraboxshare.com","terafileshare.com","teradlbox.com",
  "teradownload.app","terabox.in",
];

// Domains to try for jsToken + share/list (cookie's own domain first)
const TRY_DOMAINS = [
  "dm.1024tera.com",
  "1024terabox.com",
  "terabox.app",
  "dm.terabox.app",
  "www.terabox.com",
  "nephobox.com",
];

// Domains to try for HLS streaming
const STREAMING_DOMAINS = [
  "terabox.app",
  "nephobox.com",
  "1024terabox.com",
  "dm.1024tera.com",
  "dm.terabox.app",
];

// HLS quality types (confirmed via HAR analysis)
const HLS_TYPES = [
  { key: "1080p", type: "M3U8_AUTO_1080" },
  { key: "720p",  type: "M3U8_FLV_264_720" },
  { key: "480p",  type: "M3U8_FLV_264_480" },
  { key: "360p",  type: "M3U8_FLV_264_360" },
];

// ── Utils ─────────────────────────────────────────────────────────────────────

function jsonResp(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data, null, 2), {
    status,
    headers: { "Content-Type": "application/json", ...corsHeaders, ...extraHeaders },
  });
}

// Accepts: full URL, bare surl ID, or surl with leading "1"
function resolveSurl(input) {
  input = input.trim();

  if (input.startsWith("http")) {
    try {
      const p = new URL(input);
      const m = p.pathname.match(/\/s\/([a-zA-Z0-9_-]+)/);
      if (m) return m[1];
      const q = p.searchParams.get("surl");
      if (q) return q;
    } catch {}
    return null;
  }

  if (input.includes("/s/")) {
    const m = input.match(/\/s\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
  }

  // Bare ID (alphanumeric, dashes, underscores only)
  if (/^[a-zA-Z0-9_-]+$/.test(input)) {
    return input;
  }

  return null;
}

// Ported from TeraBox-Dl-main's isValidShareUrl: if the input was a full
// URL (not a bare surl/ID), check its host is actually a known Terabox
// domain BEFORE spending a jsToken round-trip on it — a clearly-wrong host
// (typo, wrong site entirely) now fails immediately with a useful message
// instead of a slow, confusing "jsToken not found" a few seconds later.
function isKnownTeraboxHost(input) {
  input = input.trim();
  if (!input.startsWith("http")) return true; // bare surl/ID — nothing to validate
  try {
    const h = new URL(input).hostname.toLowerCase();
    return TERABOX_DOMAINS.some(d => h === d || h.endsWith("." + d));
  } catch {
    return false;
  }
}

function formatBytes(bytes) {
  if (!bytes || bytes == 0) return "0 B";
  bytes = parseInt(bytes);
  const units = ["B","KB","MB","GB","TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return (bytes / Math.pow(1024, i)).toFixed(2) + " " + units[i];
}

function formatDuration(seconds) {
  if (!seconds) return null;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  if (h > 0) return `${h}:${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
  return `${m}:${String(s).padStart(2,"0")}`;
}

function detectQuality(item) {
  const size = Number(item.size || 0);
  if (size > 8e9)   return "4K";
  if (size > 3e9)   return "1080p";
  if (size > 1e9)   return "720p";
  if (size > 400e6) return "480p";
  if (size > 0)     return "360p";
  return null;
}

// Sums #EXTINF segment durations in a raw m3u8 playlist — used to detect
// Terabox's short ~30s "preview" playlist before ever handing an HLS URL
// to the browser (see the /play pre-check below).
function sumExtinfDuration(text) {
  return text
    .split("\n")
    .filter(l => l.startsWith("#EXTINF:"))
    .reduce((sum, l) => {
      const v = parseFloat(l.slice("#EXTINF:".length));
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);
}

// ── Public cookie-pool fallback (ported from terabox-auto-cookie.js) ──────────
// If this Worker's OWN configured NDUS secret is missing (or, via
// fetchTeraboxDataWithRetry below, temporarily stops working), fall back to
// a shared pool of publicly-known working `ndus=` cookies instead of
// hard-failing every request. Cached in-isolate memory, refreshed if empty.
let PUBLIC_COOKIE_POOL = [];
let publicPoolFetchedAt = 0;
const PUBLIC_POOL_TTL = 30 * 60 * 1000; // 30 min — pool entries rotate/expire upstream

async function refreshPublicCookiePool() {
  try {
    const resp = await fetch("https://tera.backend.live/cookies-list");
    if (!resp.ok) return;
    const list = await resp.json();
    if (Array.isArray(list)) {
      PUBLIC_COOKIE_POOL = list.filter(c => typeof c === "string" && c.startsWith("ndus="));
      publicPoolFetchedAt = Date.now();
    }
  } catch {
    // Best-effort — an unreachable pool just means no fallback is available.
  }
}

async function getPublicPoolCookie(randomize) {
  if (!PUBLIC_COOKIE_POOL.length || Date.now() - publicPoolFetchedAt > PUBLIC_POOL_TTL) {
    await refreshPublicCookiePool();
  }
  if (!PUBLIC_COOKIE_POOL.length) return null;
  return randomize
    ? PUBLIC_COOKIE_POOL[Math.floor(Math.random() * PUBLIC_COOKIE_POOL.length)]
    : PUBLIC_COOKIE_POOL[0];
}

// Now async: still returns your own configured NDUS cookie (+ CSRF/browserid/
// TSID/ndut_fmt) first when set — that stays the primary, most-reliable path.
// Only reaches into the public pool when NDUS isn't configured at all, or
// when `forcePublic` is passed (used by the retry fallback below).
async function buildCookie(env, forcePublic = false) {
  const ndus      = env.NDUS?.trim();
  const csrf      = env.CSRF_TOKEN?.trim();
  const browserid = env.BROWSER_ID?.trim();
  const tsid      = env.TSID?.trim();
  const ndutFmt   = env.NDUT_FMT?.trim();

  if (ndus && !forcePublic) {
    let c = `ndus=${ndus}`;
    if (csrf)      c += `; csrfToken=${csrf}`;
    if (browserid) c += `; browserid=${browserid}`;
    if (tsid)      c += `; TSID=${tsid}`;
    if (ndutFmt)   c += `; ndut_fmt=${ndutFmt}`;
    return c;
  }

  // No configured NDUS (or a retry explicitly asked for a public one) —
  // fall back to the shared public pool.
  const pooled = await getPublicPoolCookie(forcePublic);
  return pooled || null;
}

// Extract sign+timestamp from thumbnail URL (fallback when share/list omits them)
function extractSignFromThumb(thumbs) {
  try {
    const u = thumbs?.url1 || thumbs?.url2 || thumbs?.url3 || thumbs?.icon;
    if (!u) return null;
    const p = new URL(u);
    const sign = p.searchParams.get("sign");
    const time = p.searchParams.get("time");
    if (sign && time) return { sign, timestamp: time };
  } catch {}
  return null;
}

function buildSubtitleResponse(arr) {
  if (!arr?.length) return null;
  let m3u8 = "#EXTM3U\n";
  const tracks = [];
  for (const s of arr) {
    const lang = s.lan || s.language || "und";
    const name = s.lan_name || s.language_name || lang.toUpperCase();
    const u    = s.url || s.subtitle_url || "";
    if (!u) continue;
    m3u8 += `#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subs",LANGUAGE="${lang}",NAME="${name}",URI="${u}"\n`;
    tracks.push({ lang, name, url: u });
  }
  return { format: "M3U8", count: arr.length, m3u8_playlist: m3u8, tracks };
}

// ── jsToken ───────────────────────────────────────────────────────────────────

async function getJsToken(surl, cookieStr) {
  for (const domain of TRY_DOMAINS) {
    try {
      const resp = await fetch(`https://${domain}/sharing/link?surl=${surl}`, {
        headers: {
          "User-Agent": UA, "Cookie": cookieStr,
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        },
        redirect: "follow",
      });
      const text = await resp.text();
      const patterns = [
        /fn%28%22(.*?)%22%29/,
        /fn\("(.*?)"\)/,
        /jsToken['":\s]+['"]([^'"]+)['"]/,
        /window\.jsToken\s*=\s*['"]([^'"]+)['"]/,
        /"jsToken"\s*:\s*"([^"]+)"/,
      ];
      for (const p of patterns) {
        const m = text.match(p);
        if (m?.[1]) return { token: m[1], domain };
      }
    } catch {}
  }
  return null;
}

// ── Share List ────────────────────────────────────────────────────────────────

async function getShareList(shorturl, jsToken, domain, cookieStr, dir = null) {
  const u = new URL(`https://${domain}/share/list`);
  u.searchParams.append("app_id", "250528");
  u.searchParams.append("web", "1");
  u.searchParams.append("channel", "dubox");
  u.searchParams.append("clienttype", "0");
  u.searchParams.append("jsToken", jsToken || "");
  u.searchParams.append("shorturl", shorturl);
  u.searchParams.append("num", "500");
  if (dir) {
    u.searchParams.append("dir", dir);
  } else {
    u.searchParams.append("root", "1");
  }

  const resp = await fetch(u.toString(), {
    headers: {
      "User-Agent": "dubox;4.16.1;ASUS_Z01QD;android-android;9;JSbridge1.0.10;jointbridge;1.1.39",
      "Accept": "application/json, text/plain, */*",
      "X-Requested-With": "com.dubox.drive",
      "Referer": `https://${domain}/sharing/link?surl=${shorturl}`,
      "Cookie": cookieStr,
      "Origin": "https://terabox.com",
    },
  });
  try {
    return await resp.json();
  } catch {
    // Upstream sometimes returns an HTML error/captcha page instead of JSON
    // (e.g. rate-limited or blocked) — surface as an errno instead of throwing
    // and crashing the whole fetchTeraboxData call.
    return { errno: -1, list: [], _non_json: true };
  }
}

// ── HLS via share/streaming (HAR confirmed exact params) ─────────────────────

async function getHLSLinks(item, shareInfo, cookieStr, jsToken, surl) {
  const result = { fast_stream_url: null, stream_url: null, subtitle_url: null, debug: [] };
  if (!shareInfo.uk || !shareInfo.shareid) {
    result.debug.push("missing uk/shareid in shareInfo");
    return result;
  }

  // Warn (not silently fail) if sign/timestamp are missing — request will likely
  // come back as a signature-mismatch error instead of a valid m3u8.
  if (!shareInfo.sign || !shareInfo.timestamp) {
    result.debug.push("sign/timestamp missing — streaming request likely to fail signature check");
  }

  const hls = {};
  // errno 130 (HAR-confirmed) means "this quality genuinely doesn't exist
  // for this file" — it comes back the same on every domain, so retrying
  // other domains for it just wastes 4 more requests. Skip it immediately.
  const unavailable = new Set();
  // errno -21 "no authentic" (HAR-confirmed) means jsToken/sign went stale
  // mid-run — refresh jsToken once and retry, instead of giving up.
  let currentJsToken = jsToken;
  let triedTokenRefresh = false;

  const buildUrl = (domain, type, token) => {
    const su = new URL(`https://${domain}/share/streaming`);
    su.searchParams.append("uk",         String(shareInfo.uk));
    su.searchParams.append("shareid",    String(shareInfo.shareid));
    su.searchParams.append("type",       type);
    su.searchParams.append("fid",        String(item.fs_id));
    su.searchParams.append("sign",       shareInfo.sign || "");
    su.searchParams.append("timestamp",  String(shareInfo.timestamp || ""));
    su.searchParams.append("jsToken",    token || "");
    su.searchParams.append("esl",        "1");
    su.searchParams.append("isplayer",   "1");
    su.searchParams.append("ehps",       "1");
    su.searchParams.append("clienttype", "0");
    su.searchParams.append("web",        "1");
    su.searchParams.append("app_id",     "250528");
    su.searchParams.append("channel",    "dubox");
    return su;
  };

  for (const domain of STREAMING_DOMAINS) {
    // Try every domain until ALL qualities are found, not just 3 —
    // otherwise 1080p (tried last) is frequently skipped even when available.
    if (Object.keys(hls).length + unavailable.size >= HLS_TYPES.length) break;
    for (const { key, type } of HLS_TYPES) {
      if (hls[key] || unavailable.has(key)) continue;

      let su = buildUrl(domain, type, currentJsToken);

      try {
        let r = await fetch(su.toString(), {
          headers: {
            "User-Agent": UA, "Cookie": cookieStr,
            "Referer": `https://${domain}/`, "Accept": "*/*",
          },
        });

        if (!r.ok) {
          result.debug.push(`${domain} ${key}: HTTP ${r.status}`);
          continue;
        }

        let text = (await r.text()).replace(/^\uFEFF/, "").trimStart(); // strip BOM/leading whitespace

        if (text.startsWith("#EXTM3U")) {
          hls[key] = su.toString();
          if (!result.stream_url) result.stream_url = su.toString();
          continue;
        }

        // Response wasn't a valid m3u8 — parse the JSON error body so we can
        // react to specific errno values instead of just logging and moving on.
        let errno = null, reason = text.slice(0, 200);
        try {
          const j = JSON.parse(text);
          errno = j.errno;
          reason = `errno=${j.errno ?? "?"} ${j.show_msg || j.errmsg || j.error_msg || ""}`.trim();
        } catch {}

        if (errno === 130) {
          unavailable.add(key);
          result.debug.push(`${domain} ${key}: not available for this file (errno 130) — skipping remaining domains for this quality`);
          continue;
        }

        if (errno === 400141) {
          // "need verify" — confirmed (via real responses) that this can gate
          // ONLY the higher qualities (e.g. 1080p/720p) while lower ones
          // (480p/360p) still succeed on retry. It is NOT a reliable signal
          // that every quality is blocked, so we only blacklist the specific
          // quality that actually returned this error and keep trying the
          // rest — previously this marked ALL qualities unavailable and
          // aborted immediately, which silently threw away 480p/360p even
          // when they were fetchable.
          unavailable.add(key);
          result.verificationNeeded = true;
          result.debug.push(`${domain} ${key}: account needs verification (errno 400141) — log into Terabox in a browser with the configured NDUS account and complete the verification challenge for higher qualities; lower qualities are still attempted`);
          continue;
        }

        if (errno === -21 && !triedTokenRefresh && surl) {
          triedTokenRefresh = true;
          const refreshed = await getJsToken(surl, cookieStr);
          if (refreshed?.token) {
            currentJsToken = refreshed.token;
            su = buildUrl(domain, type, currentJsToken);
            try {
              r = await fetch(su.toString(), {
                headers: {
                  "User-Agent": UA, "Cookie": cookieStr,
                  "Referer": `https://${domain}/`, "Accept": "*/*",
                },
              });
              text = (await r.text()).replace(/^\uFEFF/, "").trimStart();
              if (text.startsWith("#EXTM3U")) {
                hls[key] = su.toString();
                if (!result.stream_url) result.stream_url = su.toString();
                continue;
              }
              try {
                const j2 = JSON.parse(text);
                reason = `errno=${j2.errno ?? "?"} ${j2.show_msg || j2.errmsg || j2.error_msg || ""}`.trim();
              } catch {}
            } catch (e) {
              reason = `retry fetch failed — ${e.message || e}`;
            }
          }
          result.debug.push(`${domain} ${key}: ${reason} (after jsToken refresh attempt)`);
          continue;
        }

        result.debug.push(`${domain} ${key}: non-m3u8 response — ${reason}`);
      } catch (e) {
        result.debug.push(`${domain} ${key}: fetch failed — ${e.message || e}`);
      }
    }
  }

  if (Object.keys(hls).length) {
    result.fast_stream_url = hls;
    return result;
  }

  // Fallback: mediameta (older endpoint, sometimes returns clarity URLs)
  for (const domain of TRY_DOMAINS) {
    const metaUrl = new URL(`https://${domain}/share/mediameta`);
    metaUrl.searchParams.append("app_id", "250528");
    metaUrl.searchParams.append("clienttype", "0");
    metaUrl.searchParams.append("uk", String(shareInfo.uk));
    metaUrl.searchParams.append("shareid", String(shareInfo.shareid));
    metaUrl.searchParams.append("fid", String(item.fs_id));
    if (shareInfo.sign)      metaUrl.searchParams.append("sign", shareInfo.sign);
    if (shareInfo.timestamp) metaUrl.searchParams.append("timestamp", String(shareInfo.timestamp));

    try {
      const resp = await fetch(metaUrl.toString(), {
        headers: { "User-Agent": UA, "Accept": "application/json",
          "Cookie": cookieStr, "Referer": `https://${domain}/` },
      });
      if (!resp.ok) {
        result.debug.push(`mediameta ${domain}: HTTP ${resp.status}`);
        continue;
      }
      const meta = await resp.json();
      if (meta.errno !== 0 || !meta.video_info) {
        result.debug.push(`mediameta ${domain}: errno=${meta.errno} ${meta.errmsg || ""}`.trim());
        continue;
      }

      const vi = meta.video_info;
      const clarityHls = {};
      if (vi.clarity1?.url) clarityHls["360p"]  = vi.clarity1.url;
      if (vi.clarity2?.url) clarityHls["480p"]  = vi.clarity2.url;
      if (vi.clarity3?.url) clarityHls["720p"]  = vi.clarity3.url;
      if (vi.clarity4?.url) clarityHls["1080p"] = vi.clarity4.url;
      if (vi.clarity5?.url) clarityHls["4K"]    = vi.clarity5.url;

      if (Object.keys(clarityHls).length) {
        result.fast_stream_url = clarityHls;
        // stream_url from this fallback path overrides any earlier (empty) value;
        // this is the only path that sets it when the primary HLS loop found nothing.
        result.stream_url = vi.normal_video_url || vi.video_url || item.dlink || null;
        if (meta.subtitle_info?.length) result.subtitle_url = buildSubtitleResponse(meta.subtitle_info);
        return result;
      }
    } catch (e) {
      result.debug.push(`mediameta ${domain}: fetch failed — ${e.message || e}`);
    }
  }

  return result;
}

// ── Process single file ───────────────────────────────────────────────────────

async function processFile(item, shareInfo, cookieStr, jsToken, domain, origin, surl) {
  const isVideo = String(item.category) === "1";
  const isAudio = String(item.category) === "2";
  const fileShareInfo = { ...shareInfo };

  // Fix missing sign/timestamp from thumbnail
  if ((!fileShareInfo.sign || !fileShareInfo.timestamp) && item.thumbs) {
    const ts = extractSignFromThumb(item.thumbs);
    if (ts) { fileShareInfo.sign = ts.sign; fileShareInfo.timestamp = ts.timestamp; }
  }

  let hls = { fast_stream_url: null, stream_url: item.dlink || null, subtitle_url: null, debug: [] };

  if (isVideo) {
    const h = await getHLSLinks(item, fileShareInfo, cookieStr, jsToken, surl);
    if (h.fast_stream_url) {
      hls.fast_stream_url = h.fast_stream_url;
      hls.stream_url = h.stream_url || item.dlink || null;
    }
    if (h.subtitle_url) hls.subtitle_url = h.subtitle_url;
    if (h.debug?.length) hls.debug = h.debug;
    if (h.verificationNeeded) hls.verification_needed = true;
  }

  const thumb = item.thumbs?.url3 || item.thumbs?.url2 || item.thumbs?.url1 || null;

  // dlink from share/list is hotlink-protected: it 403s without the right
  // User-Agent/Referer/cookie, which a user's browser tab won't send.
  // Route it through our own /download proxy so it always works when clicked,
  // while still exposing the raw dlink for callers that want to fetch it themselves.
  const rawDlink = item.dlink || null;
  // Absolute URL (not relative) so this works for callers hitting /api directly,
  // not just our own /play HTML page which happens to share the same origin.
  const proxyDownloadLink = rawDlink
    ? `${origin}/download?fs_id=${encodeURIComponent(item.fs_id)}&dlink=${encodeURIComponent(rawDlink)}&name=${encodeURIComponent(item.server_filename || "file")}`
    : null;

  // fast_stream_url holds RAW terabox.app share/streaming links — these need
  // our NDUS cookie (which only lives in this Worker) and, in a browser, hit
  // a CORS wall (Terabox's CDN sends no Access-Control-Allow-Origin), so any
  // caller trying to hand fast_stream_url straight to a <video>/HLS.js player
  // will fail exactly like it did on /play before /hls-proxy existed.
  // playback_url mirrors what /play already does internally: every quality
  // wrapped in this Worker's own /hls-proxy, so ANY client hitting /api
  // directly (not just our built-in player) gets a stream URL on our own
  // domain that "just works" — same shape as tera.backend.live's
  // {"streaming_url": "https://tera.backend.live/file/xxx.m3u8"} response.
  let playbackUrls = null;
  if (hls.fast_stream_url) {
    playbackUrls = {};
    for (const [q, rawM3u8] of Object.entries(hls.fast_stream_url)) {
      playbackUrls[q] = buildHlsProxyUrl(origin, rawM3u8, item.duration ? Number(item.duration) : 0, proxyDownloadLink);
    }
  }
  // Same 480p-first priority /play uses (fast start, less likely to be
  // gated behind Terabox's verification requirement) — previously this
  // just took Object.values(...)[0], which is whatever quality happened
  // to resolve first (often 1080p), so /api's playback_url could silently
  // disagree with what /play itself actually streams by default.
  const PLAYBACK_QUALITY_PRIORITY = ["480p", "360p", "720p", "1080p", "4K"];
  const playbackUrl = playbackUrls
    ? (PLAYBACK_QUALITY_PRIORITY.map(q => playbackUrls[q]).find(Boolean) || Object.values(playbackUrls)[0])
    : (hls.stream_url ? proxyDownloadLink : null); // non-HLS fallback: proxied direct file

  return {
    file_name:        item.server_filename || null,
    file_type:        isVideo ? "video" : isAudio ? "audio" : "file",
    file_path:        item.path || item.server_filename || null,
    size:             Number(item.size || 0),
    size_formatted:   formatBytes(item.size),
    duration:         item.duration ? formatDuration(Number(item.duration)) : null,
    duration_seconds: item.duration ? Number(item.duration) : null, // raw seconds — used to detect a truncated HLS preview (see buildPlayerHTML)
    quality:          detectQuality(item),
    fs_id:            String(item.fs_id || ""),
    thumbnail:        thumb,
    download_link:    proxyDownloadLink,   // proxied — works when clicked directly in a browser
    raw_download_link: rawDlink,           // original Terabox dlink, time-limited & hotlink-protected
    playback_url:     playbackUrl,         // ready to hand to <video>/HLS.js as-is — proxied through this Worker
    playback_urls:    playbackUrls,        // per-quality proxied HLS URLs (same domain, no cookie/CORS needed)
    stream_url:       hls.stream_url,
    fast_stream_url:  hls.fast_stream_url, // raw Terabox links — kept for callers that fetch server-side themselves
    subtitle:         hls.subtitle_url,
    debug:            hls.debug?.length ? hls.debug : undefined,
    verification_needed: hls.verification_needed || undefined,
  };
}

// ── Recursive folder fetch ────────────────────────────────────────────────────

async function fetchFolderFiles(folderPath, shorturl, jsToken, domain, cookieStr, depth = 0) {
  // Defensive cap — real Terabox folder trees are shallow, but nothing
  // stops a malformed/unexpected API response from creating a very deep or
  // even circular `path` chain, which would otherwise recurse without limit
  // (stack overflow) and fire an unbounded number of upstream requests.
  if (depth > 12) return [];
  try {
    const data  = await getShareList(shorturl, jsToken, domain, cookieStr, folderPath);
    const items = data.list || [];
    let result  = [];
    for (const item of items) {
      if (String(item.isdir) === "1") {
        const sub = await fetchFolderFiles(item.path, shorturl, jsToken, domain, cookieStr, depth + 1);
        result = result.concat(sub);
      } else {
        result.push(item);
      }
    }
    return result;
  } catch { return []; }
}

// ── Main Fetcher ──────────────────────────────────────────────────────────────

async function fetchTeraboxData(surlInput, cookieStr, origin) {
  let surl = surlInput;
  let shorturl = surl;
  if (surl.startsWith("1") && surl.length > 20) shorturl = surl.substring(1);

  // Step 1: jsToken (try shorturl first, then full surl)
  let tokenResult = await getJsToken(shorturl, cookieStr);
  if (!tokenResult) tokenResult = await getJsToken(surl, cookieStr);
  if (!tokenResult) {
    return { error: "jsToken not found. Cookies may be expired or invalid." };
  }
  const { token: jsToken, domain } = tokenResult;

  // Step 2: share/list (try shorturl first, then full surl)
  let result = await getShareList(shorturl, jsToken, domain, cookieStr);
  if (!result.list?.length) result = await getShareList(surl, jsToken, domain, cookieStr);
  if (!result.list?.length) {
    return { error: "Files not found. Link may be expired or private.", errno: result.errno };
  }

  // share_id field confirmed via HAR (NOT "shareid")
  const shareInfo = {
    shareid:   result.share_id  || result.shareid   || null,
    uk:        result.uk        || result.creator_uk || null,
    sign:      result.sign      || null,
    timestamp: result.timestamp || result.server_time || null,
  };

  // share/list is capped at num=500 — if a share/folder has more items than
  // that, the rest are silently dropped by Terabox's API with no error.
  // Surface this so callers at least know the result might be incomplete,
  // since adding real pagination would need confirming Terabox returns a
  // cursor/has_more field, which can't be verified without a live call.
  const possiblyTruncated = result.list.length >= 500;

  const rawFolders = result.list.filter(i => String(i.isdir) === "1");
  const rawFiles   = result.list.filter(i => String(i.isdir) !== "1");

  let folderFiles = [];
  for (const folder of rawFolders) {
    const sub = await fetchFolderFiles(folder.path, shorturl, jsToken, domain, cookieStr);
    folderFiles = folderFiles.concat(sub);
  }

  // Process files in small concurrent batches instead of all at once —
  // each video can fire up to 5 domains × 4 qualities = 20 streaming
  // requests, so doing this for every file in parallel (Promise.all over
  // the whole list) floods Terabox with requests and is the likely cause
  // of the random "fid is invalid" (errno 2) / "some error happends"
  // (errno 31339) responses seen in the HAR — those look like rate-limit
  // glitches, not real per-file problems.
  const allItems = [...rawFiles, ...folderFiles];
  const FILE_CONCURRENCY = 3;
  const files = [];
  for (let i = 0; i < allItems.length; i += FILE_CONCURRENCY) {
    const batch = allItems.slice(i, i + FILE_CONCURRENCY);
    const processed = await Promise.all(
      batch.map(item => processFile(item, shareInfo, cookieStr, jsToken, domain, origin, shorturl))
    );
    files.push(...processed);
  }

  const folders = rawFolders.map(f => ({
    name: f.server_filename,
    type: "folder",
    path: f.path || f.server_filename,
  }));

  return { files, folders, domain, possibly_truncated: possiblyTruncated };
}

// ── Guest-session extraction (no NDUS needed at all) ───────────────────────
// Ported from TeraDL's terabox1.py "Mode 1": for a PUBLIC share, Terabox's
// mobile/wap endpoints (wap/share/filelist, api/shorturlinfo, share/download)
// work with a fresh, anonymous guest session — no logged-in NDUS cookie
// required, ours or the public pool's. This is a genuinely independent
// fallback: it doesn't depend on any account being valid/not-rate-limited,
// only on the share itself being public. Trade-off: no HLS streaming links
// this way (share/streaming needs a real session), only a raw direct-file
// dlink — which is exactly what our player already falls back to smoothly.
const GUEST_UA = "Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

function extractSetCookies(response) {
  const parts = [];
  for (const [key, value] of response.headers.entries()) {
    if (key.toLowerCase() === "set-cookie") parts.push(value.split(";")[0]);
  }
  return parts.join("; ");
}

async function fetchGuestSession(surl) {
  const shortUrl = surl.startsWith("1") && surl.length > 20 ? surl.substring(1) : surl;

  const flResp = await fetch(`https://www.terabox.app/wap/share/filelist?surl=${shortUrl}`, {
    headers: { "User-Agent": GUEST_UA },
  });
  const flText = (await flResp.text()).replace(/\\/g, "");
  const jsTokenMatch = flText.match(/%28%22(.*?)%22%29/);
  if (!jsTokenMatch) return null;
  const jsToken = jsTokenMatch[1];
  const guestCookie = extractSetCookies(flResp);
  if (!guestCookie) return null;

  const infoUrl = `https://www.terabox.com/api/shorturlinfo?app_id=250528&shorturl=1${shortUrl}&root=1`;
  const infoResp = await fetch(infoUrl, { headers: { "User-Agent": GUEST_UA, "Cookie": guestCookie } });
  let info;
  try { info = await infoResp.json(); } catch { return null; }
  if (!info || info.errno || !info.list?.length) return null;

  return { info, jsToken, guestCookie, shortUrl };
}

async function getGuestDownloadLink(fsId, uk, shareid, timestamp, sign, jsToken, guestCookie) {
  const params = new URLSearchParams({
    uk: String(uk), sign: String(sign || ""), shareid: String(shareid), primaryid: String(shareid),
    timestamp: String(timestamp || ""), jsToken, fid_list: `[${fsId}]`,
    app_id: "250528", channel: "dubox", product: "share", clienttype: "0",
    "dp-logid": "", nozip: "0", web: "1",
  });
  try {
    const resp = await fetch(`https://www.terabox.com/share/download?${params.toString()}`, {
      headers: { "User-Agent": GUEST_UA, "Cookie": guestCookie },
    });
    const data = await resp.json();
    if (data.errno) return null;
    return data.dlink || null;
  } catch { return null; }
}

async function fetchTeraboxDataGuestMode(surl, origin) {
  const session = await fetchGuestSession(surl);
  if (!session) return { error: "Guest session extraction failed (share may be private, or Terabox changed its wap endpoint)." };

  const { info, jsToken, guestCookie } = session;
  const rawFiles = info.list.filter(i => String(i.isdir) !== "1");
  if (!rawFiles.length) return { error: "No files found via guest session." };

  const files = [];
  for (const item of rawFiles) {
    const dlink = await getGuestDownloadLink(item.fs_id, info.uk, info.shareid, info.timestamp, info.sign, jsToken, guestCookie);
    const isVideo = String(item.category) === "1";
    const proxyDownloadLink = dlink
      ? `${origin}/download?fs_id=${encodeURIComponent(item.fs_id)}&dlink=${encodeURIComponent(dlink)}&name=${encodeURIComponent(item.server_filename || "file")}`
      : null;
    files.push({
      file_name: item.server_filename || null,
      file_type: isVideo ? "video" : "file",
      size: Number(item.size || 0),
      size_formatted: formatBytes(item.size),
      duration: item.duration ? formatDuration(Number(item.duration)) : null,
      duration_seconds: item.duration ? Number(item.duration) : null,
      quality: detectQuality(item),
      fs_id: String(item.fs_id || ""),
      thumbnail: item.thumbs?.url3 || item.thumbs?.url2 || item.thumbs?.url1 || null,
      download_link: proxyDownloadLink,
      raw_download_link: dlink,
      playback_urls: null, // guest mode has no HLS — player falls back to direct file, which already works smoothly
      stream_url: dlink,
      source: "guest_session", // flagged so callers/debugging can tell this came from the no-cookie fallback
    });
  }

  if (!files.some(f => f.download_link)) return { error: "Guest session found files but couldn't get any download link." };
  return { files, folders: [], domain: "guest" };
}

// from terabox-auto-cookie.js: if resolving with our primary cookie (the
// env-configured NDUS, or nothing) fails, retry a couple more times with a
// random cookie pulled from the public pool before giving up — instead of
// immediately erroring out just because one particular cookie is currently
// dead/rate-limited.
async function fetchTeraboxDataWithRetry(surl, primaryCookie, origin, env) {
  let lastResult = null;
  const MAX_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cookieStr = attempt === 0 ? primaryCookie : await buildCookie(env, /* forcePublic */ true);
    if (!cookieStr) { lastResult = { error: "No working cookie available (own NDUS missing and public pool empty/unreachable)." }; continue; }
    const result = await fetchTeraboxData(surl, cookieStr, origin);
    if (!result.error) return result;
    lastResult = result;
  }

  // Last resort: every NDUS-based attempt (own + public pool) failed —
  // try the cookie-free guest-session path. Won't get HLS, but a working
  // direct download/stream link beats a hard failure.
  const guestResult = await fetchTeraboxDataGuestMode(surl, origin);
  if (!guestResult.error) return guestResult;

  return lastResult || guestResult || { error: "All cookies and guest session failed." };
}

// Ported from terabox-auto-cookie.js's proxyDownload: if the primary cookie's
// fetch for a direct file byte-range comes back non-ok, retry a couple more
// times with a random public-pool cookie before giving up — a cookie being
// temporarily dead/rate-limited shouldn't fail the whole download.
async function fetchDlinkWithCookieRetry(dlink, extraHeaders, rangeHeader, env, primaryCookie, cfOptions) {
  const MAX_ATTEMPTS = 3;
  let lastResp = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const cookieStr = attempt === 0 ? primaryCookie : await buildCookie(env, /* forcePublic */ true);
    if (!cookieStr) continue;
    const headers = { "User-Agent": UA, "Cookie": cookieStr, "Referer": "https://www.terabox.com/", ...extraHeaders };
    if (rangeHeader) headers["Range"] = rangeHeader;
    try {
      const opts = { headers, redirect: "follow" };
      if (cfOptions) opts.cf = cfOptions;
      const resp = await fetch(dlink, opts);
      if (resp.ok || resp.status === 206) return resp;
      lastResp = resp;
    } catch {
      // network error on this cookie/attempt — fall through and try the next one
    }
  }
  return lastResp;
}

// ── HLS Proxy helpers ──────────────────────────────────────────────────────────
// The player used to hand HLS.js the raw Terabox share/streaming URL, so the
// BROWSER fetched the playlist and every .ts segment directly from Terabox —
// with no cookie attached (the NDUS/CSRF/browserid cookie lives only in this
// Worker's secrets, never in the visitor's browser). Terabox then rejected
// those requests, which surfaced in the player as a generic "network error /
// link expired" even though the link itself was fresh and valid.
//
// Fix: route both the playlist and every segment through this Worker so the
// cookie is attached server-side, same as /download already does for direct
// file links.

function isAllowedStreamingHost(hostname) {
  const h = hostname.toLowerCase();
  return (
    TERABOX_DOMAINS.some(d => h === d || h.endsWith("." + d)) ||
    STREAMING_DOMAINS.some(d => h === d || h.endsWith("." + d))
  );
}

function buildHlsProxyUrl(origin, m3u8Url, realDuration, fallbackUrl) {
  const params = new URLSearchParams();
  params.set("url", m3u8Url);
  // Passed through so /hls-proxy can do the same truncated-playlist ->
  // full-file redirect for external players (VLC/MX/PlayIt), which hit this
  // URL directly and never run this page's JS-based duration check.
  if (realDuration) params.set("real_duration", String(realDuration));
  if (fallbackUrl) params.set("fallback", fallbackUrl);
  return `${origin}/hls-proxy?${params.toString()}`;
}

function buildHlsSegUrl(origin, segUrl) {
  return `${origin}/hls-seg?url=${encodeURIComponent(segUrl)}`;
}

// ── HTML Player (HLS.js based, with quality switch) ───────────────────────────

function buildPlayerHTML(file, origin, playedUrl) {
  const rawTitle = file.file_name || "Terabox Player";
  const title = rawTitle.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
  const fileExt = (rawTitle.match(/\.([a-zA-Z0-9]+)$/) || ["",""])[1].toUpperCase() || "VIDEO";
  // Raw Terabox m3u8 URLs (kept around for the /download-hls links, which
  // fetch server-side themselves and don't need proxying).
  const rawHlsEntries = file.fast_stream_url ? Object.entries(file.fast_stream_url) : [];
  // Playback URLs are routed through this Worker's /hls-proxy so the NDUS
  // cookie gets attached server-side — see the "HLS Proxy helpers" comment
  // above. Without this, the browser hits Terabox directly with no cookie
  // and playback fails even though the underlying link is valid.
  const hlsEntries = origin
    ? rawHlsEntries.map(([q, u]) => [q, buildHlsProxyUrl(origin, u, file.duration_seconds, file.download_link)])
    : rawHlsEntries;

  // DEFAULT SOURCE — original file only, no HLS.
  // Per explicit preference: the player always streams file.download_link
  // (the original/full file) directly. No quality picker, no HLS attempt,
  // no mid-playback switching of any kind — the /download proxy's own
  // chunk-aligned edge caching (see RANGE_CHUNK_SIZE below) is what keeps
  // repeat/nearby plays fast instead of HLS segmenting.
  const defaultSrc = file.download_link || file.stream_url || null;
  const defaultIsHls = false;

  const streamingUrl = defaultSrc || "";

  // Quality-based download buttons removed entirely — only the single
  // "Download Full Video" button (original file) remains.
  const downloadQualityLinksHTML = "";



  // Subtitle <track> elements — routed through /subtitle-proxy so the
  // NDUS cookie is attached server-side and the response carries CORS
  // (same reasoning as the video segments going through /hls-seg). The
  // first language is marked default so captions are on by default when
  // available; the person can still switch/disable via the video
  // element's own CC menu.
  const subtitleTracks = file.subtitle?.tracks || [];
  const subtitleTracksHTML = subtitleTracks.map(({ lang, name, url: subRawUrl }, i) => {
    const proxied = `${origin}/subtitle-proxy?url=${encodeURIComponent(subRawUrl)}`;
    const safeLang = (lang || "und").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 8) || "und";
    const safeLabel = String(name || lang || "Subtitle").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
    return `<track kind="subtitles" src="${proxied.replace(/"/g,"&quot;")}" srclang="${safeLang}" label="${safeLabel}"${i === 0 ? " default" : ""}>`;
  }).join("\n");


  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AK Clouds | ${title}</title>
<meta name="description" content="Stream ${title} — powered by AK Clouds.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%98%81%EF%B8%8F%3C/text%3E%3C/svg%3E">
<meta property="og:title" content="AK Clouds | ${title}">
<meta property="og:description" content="Premium streaming experience — powered by AK Clouds.">
<meta property="og:type" content="video.other">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
:root{
  --bg:#0a0a0a; --bg-header-a:#111; --bg-header-b:#0a0a0a;
  --text:#fff; --text-muted:#aaa; --text-dim:#555; --text-dimmer:#666; --text-faint:#333;
  --card-bg:#111; --card-border:#1e1e1e; --card-hover:#161616;
  --input-bg:#1b1b1f; --input-border:#333;
  --pill-bg:#26262b; --pill-hover:#333; --pill-text:#eee;
}
[data-theme="light"]{
  --bg:#f4f4f6; --bg-header-a:#ffffff; --bg-header-b:#f4f4f6;
  --text:#111; --text-muted:#555; --text-dim:#888; --text-dimmer:#777; --text-faint:#999;
  --card-bg:#ffffff; --card-border:#e2e2e5; --card-hover:#ececef;
  --input-bg:#eeeef0; --input-border:#dcdce0;
  --pill-bg:#e8e8ec; --pill-hover:#dcdce2; --pill-text:#111;
}
*{box-sizing:border-box;margin:0;padding:0}
body{background:var(--bg);color:var(--text);font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;min-height:100vh;transition:background .2s,color .2s}
.container{max-width:700px;margin:0 auto;padding:0 0 48px}
/* Theme toggle */
.theme-toggle{position:fixed;top:16px;right:16px;z-index:100;
  background:var(--card-bg);border:1px solid var(--card-border);color:var(--text);
  width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;
  font-size:19px;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.2)}
/* Header */
.header{text-align:center;padding:32px 16px 20px;background:linear-gradient(180deg,var(--bg-header-a) 0%,var(--bg-header-b) 100%);
  opacity:0;animation:fadeUp .5s ease forwards}
@keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
@media(prefers-reduced-motion:reduce){.header{animation:none;opacity:1}}
.cloud-icon{font-size:48px;opacity:.7;margin-bottom:12px}
.header h1{font-family:'Space Grotesk',sans-serif;font-size:28px;font-weight:700;color:var(--text-muted);letter-spacing:-0.5px}
.header p{color:var(--text-dim);font-size:14px;margin-top:4px}
/* Video */
video{width:100%;max-height:56vw;background:#000;display:block}
.status-bar{background:var(--card-bg);padding:8px 16px;font-size:12px;color:var(--text-dimmer);min-height:28px;text-align:center}
.buffer-track{height:6px;background:var(--card-bg);margin:0 16px;border-radius:4px;overflow:hidden}
.buffer-fill{height:100%;background:linear-gradient(90deg,#2563eb,#16a34a);width:0%;transition:width .2s linear}
.buffer-pct{text-align:center;font-size:12px;color:var(--text-dimmer);margin:4px 0 8px}
.status-bar.error{color:#f87171}
/* Verification warning */
.verify-warn{margin:12px 16px;background:#2a1a0a;border:1px solid #92660b;color:#f0b95c;
  padding:10px 14px;border-radius:10px;font-size:13px}
/* Source selector card */
.section{margin:12px 16px}
.section-title{font-size:15px;font-weight:700;color:#a78bfa;margin-bottom:10px}
.radio-card{background:var(--card-bg);border-radius:14px;overflow:hidden;border:1px solid var(--card-border)}
.radio-opt{display:flex;align-items:center;justify-content:space-between;
  padding:16px 18px;cursor:pointer;border-bottom:1px solid var(--card-border);transition:.15s}
.radio-opt:last-child{border-bottom:none}
.radio-opt:hover{background:var(--card-hover)}
.radio-opt span{font-size:15px;font-weight:500}
.radio-circle{width:22px;height:22px;border-radius:50%;border:2px solid var(--input-border);
  display:flex;align-items:center;justify-content:center;flex-shrink:0}
.radio-circle.active{border-color:#f472b6}
.radio-circle.active::after{content:'';width:10px;height:10px;border-radius:50%;background:#f472b6}
/* Quality Pills (top selector, matches reference design) */
.quality-pills{display:flex;flex-wrap:wrap;gap:10px;margin:14px 16px}
.quality-pill{background:var(--pill-bg);color:var(--pill-text);border:none;border-radius:50px;
  padding:14px 22px;font-size:15px;font-weight:600;cursor:pointer;transition:.15s;flex:0 0 auto}
.quality-pill:hover{background:var(--pill-hover)}
.quality-pill.active{background:#2563eb;color:#fff}
/* Dropdown */
.dropdown-wrap{position:relative}
select{width:100%;background:var(--input-bg);border:1px solid var(--input-border);color:var(--pill-text);
  padding:14px 16px;border-radius:12px;font-size:14px;appearance:none;cursor:pointer;outline:none}
.dropdown-arrow{position:absolute;right:14px;top:50%;transform:translateY(-50%);
  color:var(--text-dim);pointer-events:none;font-size:12px}
/* File title preview */
.file-preview{margin:0 16px 4px;background:var(--card-bg);border-radius:12px;padding:14px 16px}
.file-preview p{color:var(--text-muted);font-size:13px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
/* Media Details */
.detail-card{background:var(--card-bg);border-radius:14px;padding:16px 18px;margin-bottom:10px}
.detail-card .dlabel{color:#f472b6;font-size:13px;font-weight:600;margin-bottom:6px}
.detail-card .dvalue{color:var(--pill-text);font-size:14px;word-break:break-word;line-height:1.5}
/* Streaming URL copy */
.copy-row{display:flex;gap:0;border-radius:10px;overflow:hidden;margin-top:8px}
.copy-url{flex:1;background:var(--input-bg);border:none;color:var(--text-muted);padding:13px 14px;
  font-size:13px;font-family:'JetBrains Mono',monospace;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.copy-btn{background:#2563eb;color:#fff;border:none;padding:13px 18px;
  font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;display:flex;align-items:center;gap:6px}
.copy-btn:hover{background:#1d4ed8}
.copy-hint{color:var(--text-dim);font-size:12px;margin-top:6px}
/* Action buttons */
.action-row{display:flex;flex-direction:column;gap:10px;margin:12px 16px}
.action-btn{display:flex;align-items:center;justify-content:center;gap:8px;
  width:100%;padding:14px;border-radius:50px;text-decoration:none;
  font-size:15px;font-weight:600;cursor:pointer;border:none;transition:.15s}
.btn-extern{background:#d97706;color:#fff}
.btn-extern:hover{background:#b45309}
.btn-home{background:#2563eb;color:#fff}
.btn-home:hover{background:#1d4ed8}
.btn-download{background:#2563eb;color:#fff}
.btn-download:hover{background:#1d4ed8}
/* External player row (MX / VLC / PlayIt) */
.extern-row{display:flex;gap:10px;margin:12px 16px 0}
.extern-row .action-btn{flex:1;padding:12px 8px;font-size:13px;border-radius:14px}
.btn-mx{background:linear-gradient(45deg,#2980b9,#2c3e50);color:#fff}
.btn-mx:hover{filter:brightness(1.15)}
.btn-vlc{background:linear-gradient(45deg,#e67e22,#d35400);color:#fff}
.btn-vlc:hover{filter:brightness(1.15)}
.btn-playit{background:linear-gradient(45deg,#8e44ad,#9b59b6);color:#fff}
.btn-playit:hover{filter:brightness(1.15)}
/* Footer */
footer{text-align:center;padding:24px 16px 12px;color:var(--text-faint);font-size:13px;border-top:1px solid var(--card-border);margin-top:8px}
</style>
</head>
<body>

<!-- Theme Toggle -->
<button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Toggle dark/light mode">🌙</button>

<!-- Header -->
<div class="header">
  <div class="cloud-icon">☁️</div>
  <h1>AK Clouds</h1>
  <p>Premium Streaming Experience</p>
</div>

<!-- Video Player -->
<video id="video" controls autoplay playsinline preload="auto">${subtitleTracksHTML}</video>
<div class="status-bar" id="statusBar">Loading...</div>
<div class="buffer-track" id="bufferTrack"><div class="buffer-fill" id="bufferFill" style="width:0%"></div></div>
<div class="buffer-pct" id="bufferPct">0%</div>

${file.download_link ? `<div class="section" style="margin-top:8px">
  <a class="action-btn btn-download" href="${file.download_link.replace(/"/g, "&quot;")}" download="${title.replace(/"/g,"&quot;")}">⬇ Download Full Video</a>
</div>` : ""}

${downloadQualityLinksHTML}

${file.verification_needed ? `<div class="verify-warn">⚠️ Some sources unavailable — re-verify Terabox account in browser.</div>` : ""}

<!-- File title preview -->
<div class="file-preview">
  <p>${title}</p>
</div>

<!-- Media Details -->
<div class="section">
  <div class="section-title">Media Details</div>
  ${file.file_name ? `<div class="detail-card"><div class="dlabel">File Name</div><div class="dvalue">${title}</div></div>` : ""}
  ${file.size_formatted ? `<div class="detail-card"><div class="dlabel">File Size</div><div class="dvalue">${file.size_formatted}</div></div>` : ""}
  <div class="detail-card"><div class="dlabel">Format</div><div class="dvalue">${fileExt}</div></div>
  <div class="detail-card"><div class="dlabel">Streaming Source</div><div class="dvalue">${defaultIsHls ? "HLS Stream" : "Direct File"}</div></div>
  <div class="detail-card">
    <div class="dlabel">Streaming URL</div>
    <div class="copy-row">
      <input class="copy-url" id="copyUrlInput" type="text" readonly value="${streamingUrl.replace(/"/g,"&quot;")}">
      <button class="copy-btn" onclick="copyUrl()">📋 Copy</button>
    </div>
    <div class="copy-hint">Click the copy button to copy the streaming URL</div>
  </div>
</div>

<!-- External Players -->
${defaultSrc ? `<div class="extern-row">
  <a class="action-btn btn-mx" id="mxPlayerBtn" href="#">▶ MX Player</a>
  <a class="action-btn btn-vlc" id="vlcPlayerBtn" href="#">▶ VLC Player</a>
  <a class="action-btn btn-playit" id="playitPlayerBtn" href="#">▶ PlayIt</a>
</div>` : ""}

<!-- Action Buttons -->
<div class="action-row">
  <a class="action-btn btn-home" href="javascript:history.back()">← Back to Home</a>
</div>

<!-- Footer -->
<footer>Developed by <a href="https://t.me/Anujedits76" target="_blank" rel="noopener" style="color:#60a5fa;text-decoration:none">@Anujedits76</a> | Powered by Cloudflare Workers</footer>

<script>
const video = document.getElementById('video');
const statusBar = document.getElementById('statusBar');

// Single fixed source — no quality/source picker, no HLS. Always plays
// the original/full file directly.
const STREAM_URL = ${JSON.stringify(streamingUrl)};
// Kept for the "buffer-fully-then-play" mode below, so playback feels
// exactly like an already-downloaded video: zero network involvement
// once it starts.
const FULL_FILE_URL = ${JSON.stringify(file.download_link || "")};
// Used only to record this play in the per-device "Recently Watched"
// history (localStorage) — see saveToHistory() below.
const PLAYED_URL = ${JSON.stringify(playedUrl || "")};
const PLAYED_TITLE = ${JSON.stringify(rawTitle)};
const PLAYED_THUMB = ${JSON.stringify(file.thumbnail || "")};
const PLAYED_SIZE = ${JSON.stringify(file.size_formatted || "")};

video.muted = true;
video.addEventListener('play', () => { setTimeout(() => { video.muted = false; }, 300); }, { once: true });

function setStatus(msg, isErr) {
  statusBar.textContent = msg || '';
  statusBar.className = 'status-bar' + (isErr ? ' error' : '');
}

function tryPlay() {
  const p = video.play();
  if (p && p.catch) p.then(() => setStatus('')).catch(() => setStatus('Tap to play', false));
}

function loadUrl(url) {
  video.removeAttribute('src');
  video.load();
  setStatus('Loading...', false);

  // Update streaming URL display
  const inp = document.getElementById('copyUrlInput');
  if (inp) inp.value = url;

  let settled = false;
  const markSettled = () => { settled = true; };
  setTimeout(() => { if (!settled) setStatus('Stream did not start — try another source or refresh.', true); }, 15000);

  video.src = url;
  video.addEventListener('loadedmetadata', () => { markSettled(); tryPlay(); }, { once:true });
  video.addEventListener('error', () => { markSettled(); setStatus('Failed to load video', true); }, { once:true });
}

// "Buffer fully, then play" — fetches the whole file into memory first
// (showing real download progress), then hands the browser a local blob
// URL. Once playing, the <video> element is reading from memory, not the
// network, so there is nothing left to stall or rebuffer — same feel as
// opening a file you already downloaded.
const bufferTrack = document.getElementById('bufferTrack');
const bufferFill = document.getElementById('bufferFill');
const bufferPct = document.getElementById('bufferPct');

async function bufferThenPlay(url) {
  try {
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error('fetch failed: ' + res.status);

    const total = Number(res.headers.get('Content-Length') || 0);
    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      received += value.length;
      if (total) {
        const pct = Math.min(100, Math.round((received / total) * 100));
        bufferFill.style.width = pct + '%';
        bufferPct.textContent = pct + '% buffered (' +
          (received / 1048576).toFixed(1) + ' / ' + (total / 1048576).toFixed(1) + ' MB)';
        setStatus('Buffering ' + pct + '%...');
      } else {
        bufferPct.textContent = (received / 1048576).toFixed(1) + ' MB buffered...';
        setStatus('Buffering...');
      }
    }

    const blob = new Blob(chunks, { type: res.headers.get('Content-Type') || 'video/mp4' });
    const blobUrl = URL.createObjectURL(blob);
    bufferTrack.style.display = 'none';
    bufferPct.style.display = 'none';
    setStatus('');
    video.src = blobUrl;
    tryPlay();
  } catch (e) {
    // Full-file fetch failed (blocked, offline mid-way, etc.) — fall back
    // to normal segment/range streaming rather than leaving a dead player.
    bufferTrack.style.display = 'none';
    bufferPct.style.display = 'none';
    setStatus('Full buffering failed, falling back to streaming...', true);
    loadUrl(STREAM_URL);
  }
}

// Recently Watched — per-device history stored in localStorage (never sent
// to any server). Shared key/shape with the homepage's history list.
const HISTORY_KEY = 'akclouds_history';
const HISTORY_MAX = 30;
function saveToHistory() {
  if (!PLAYED_URL) return;
  try {
    let list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
    if (!Array.isArray(list)) list = [];
    list = list.filter(e => e && e.url !== PLAYED_URL);
    list.unshift({ url: PLAYED_URL, title: PLAYED_TITLE, thumb: PLAYED_THUMB, size: PLAYED_SIZE, ts: Date.now() });
    if (list.length > HISTORY_MAX) list = list.slice(0, HISTORY_MAX);
    localStorage.setItem(HISTORY_KEY, JSON.stringify(list));
  } catch {}
}
saveToHistory();

// Immediate streaming — plays right away and buffers progressively in the
// background (HLS with the tuned buffer/prefetch config above), instead of
// waiting for the whole file to download first. Fast start > guaranteed
// zero-stall; the buffer/prefetch tuning above already keeps stalls rare.
bufferTrack.style.display = 'none';
bufferPct.style.display = 'none';
loadUrl(STREAM_URL);
window._externalUrl = STREAM_URL;

// Keyboard shortcuts
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
  if (e.code === 'Space') { e.preventDefault(); video.paused ? video.play() : video.pause(); }
  if (e.code === 'ArrowRight') { e.preventDefault(); video.currentTime += 5; }
  if (e.code === 'ArrowLeft') { e.preventDefault(); video.currentTime -= 5; }
  if (e.code === 'KeyF') { e.preventDefault(); if (document.fullscreenElement) document.exitFullscreen(); else video.requestFullscreen && video.requestFullscreen(); }
});

// Copy URL
function copyUrl() {
  const inp = document.getElementById('copyUrlInput');
  if (!inp) return;
  navigator.clipboard ? navigator.clipboard.writeText(inp.value).then(() => {
    const btn = document.querySelector('.copy-btn');
    if (btn) { btn.textContent = '✅ Copied!'; setTimeout(() => btn.innerHTML = '📋 Copy', 2000); }
  }) : (inp.select(), document.execCommand('copy'));
}

// External Players (MX Player / VLC / PlayIt) — Android intent-based launch,
// same approach as FILE-TO-LINK-BOT's watch.html: strip the scheme and hand
// the URL to the player's package via an Android intent:// link. Always
// uses whatever source is currently selected (window._externalUrl), not a
// fixed URL, so it matches the quality the person is actually viewing.
function openExternalPlayer(pkg) {
  const url = window._externalUrl || ${JSON.stringify(defaultSrc || "").replace(/</g,"\\u003c")};
  if (!url) return;
  const clean = url.replace(/^https?:\\/\\//, '');
  if (/android/i.test(navigator.userAgent)) {
    // intent:// requires the fallback to be percent-encoded so the browser
    // itself can recover if the app isn't installed.
    const fallback = encodeURIComponent(url);
    window.location.href = \`intent://\${clean}#Intent;package=\${pkg};type=video/*;scheme=https;S.browser_fallback_url=\${fallback};end\`;
  } else {
    // No intent support outside Android (iOS/desktop) — just open the
    // stream directly so the person isn't left on a dead link.
    window.open(url, '_blank');
  }
}

const mxPlayerBtn = document.getElementById('mxPlayerBtn');
if (mxPlayerBtn) mxPlayerBtn.addEventListener('click', (e) => { e.preventDefault(); openExternalPlayer('com.mxtech.videoplayer.ad'); });

const vlcPlayerBtn = document.getElementById('vlcPlayerBtn');
if (vlcPlayerBtn) vlcPlayerBtn.addEventListener('click', (e) => { e.preventDefault(); openExternalPlayer('org.videolan.vlc'); });

const playitPlayerBtn = document.getElementById('playitPlayerBtn');
if (playitPlayerBtn) playitPlayerBtn.addEventListener('click', (e) => { e.preventDefault(); openExternalPlayer('com.playit.videoplayer'); });

// Theme toggle (dark/light) — preference saved in localStorage so it
// persists across visits. Defaults to dark (matches the original design).
function applyTheme(mode) {
  document.documentElement.setAttribute('data-theme', mode);
  const btn = document.getElementById('themeToggle');
  if (btn) btn.textContent = mode === 'light' ? '☀️' : '🌙';
}
function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  const next = current === 'light' ? 'dark' : 'light';
  applyTheme(next);
  try { localStorage.setItem('akclouds_theme', next); } catch {}
}
(function initTheme() {
  let saved = null;
  try { saved = localStorage.getItem('akclouds_theme'); } catch {}
  applyTheme(saved === 'light' ? 'light' : 'dark');
})();
</script>
</body>
</html>`;
}

// ── Per-IP rate limiter (ported from terabox-apis-main's rate_limiter.py) ──
// Sliding-window limiter so one visitor/script can't hammer this Worker
// (and, by extension, burn through the NDUS cookie / public cookie pool)
// with unlimited requests. In-memory, so it's per-isolate — Cloudflare may
// run multiple isolates across edge locations for the same Worker, so this
// is "best effort per edge location", not a single global counter. Same
// caveat the original Python version notes for its single-instance setup.
const RATE_LIMIT_HITS = new Map(); // ip -> [timestamp, ...]

function getClientIp(request) {
  return request.headers.get("CF-Connecting-IP")
    || request.headers.get("X-Forwarded-For")?.split(",")[0].trim()
    || request.headers.get("X-Real-IP")
    || "unknown";
}

function checkRateLimit(request, env) {
  const maxRequests = Number(env.RATE_LIMIT || 30);   // requests per window
  const windowSecs  = Number(env.RATE_WINDOW || 60);  // window size in seconds
  const ip = getClientIp(request);
  const now = Date.now();
  const cutoff = now - windowSecs * 1000;

  let hits = (RATE_LIMIT_HITS.get(ip) || []).filter(t => t > cutoff);

  if (hits.length >= maxRequests) {
    const retryAfter = Math.ceil((hits[0] + windowSecs * 1000 - now) / 1000) + 1;
    RATE_LIMIT_HITS.set(ip, hits); // keep pruned list even on reject
    return jsonResp({
      status: "error",
      message: "Rate limit exceeded",
      retry_after: retryAfter,
      limit: `${maxRequests} requests per ${windowSecs}s`,
    }, 429, { "Retry-After": String(retryAfter) });
  }

  hits.push(now);
  RATE_LIMIT_HITS.set(ip, hits);
  return null; // not rate-limited
}

// ── Main Worker ───────────────────────────────────────────────────────────────

export default {
  async fetch(request, env, ctx) {
    const url  = new URL(request.url);
    const path = url.pathname;

    // Keep the in-memory cache from growing unbounded over the isolate's
    // lifetime — cheap (just a Map scan) and run off the response's
    // critical path via waitUntil so it never adds latency to a request.
    ctx.waitUntil((async () => pruneExpiredCache(env))());

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // ── Health ────────────────────────────────────────────────────────────────
    if (path === "/health") {
      return jsonResp({ status: "ok", timestamp: new Date().toISOString() });
    }

    // Rate limit everything except /health (so uptime monitors never get
    // blocked) and the static homepage. The routes that actually cost real
    // work — /api, /play, /download, /hls-proxy, /hls-seg, etc. — all sit
    // behind this. Set env.RATE_LIMIT=0 to disable entirely.
    if (path !== "/" && path !== "" && Number(env.RATE_LIMIT) !== 0) {
      const limited = checkRateLimit(request, env);
      if (limited) return limited;
    }

    // ── Home ──────────────────────────────────────────────────────────────────
    if (path === "/" || path === "") {
      return new Response(`<!DOCTYPE html>
<html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>AK Clouds | Terabox API</title>
<meta name="description" content="Terabox direct link extractor and HLS media player API — get download links, streaming URLs, and metadata in JSON.">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%E2%98%81%EF%B8%8F%3C/text%3E%3C/svg%3E">
<meta property="og:title" content="AK Clouds | Terabox API">
<meta property="og:description" content="Terabox direct link extractor and HLS media player API.">
<meta property="og:type" content="website">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;700&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root{
    --bg:#0a0a0a; --bg2:#050505; --text:#eee; --text-dim:#888; --text-faint:#666;
    --card-bg:#111; --card-border:#1e1e1e; --input-bg:#1b1b1f; --input-border:#333;
    --code-bg:#161b22; --shadow:0 8px 24px rgba(0,0,0,.35);
  }
  [data-theme="light"]{
    --bg:#f4f4f6; --bg2:#eaeaee; --text:#161618; --text-dim:#666; --text-faint:#999;
    --card-bg:#ffffff; --card-border:#e2e2e6; --input-bg:#f0f0f2; --input-border:#dcdce2;
    --code-bg:#eef0f3; --shadow:0 8px 24px rgba(0,0,0,.08);
  }
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Inter',-apple-system,BlinkMacSystemFont,sans-serif;background:var(--bg);color:var(--text);
    min-height:100vh;transition:background .2s,color .2s}
  .container{max-width:900px;margin:0 auto;padding:24px 16px 48px}
  .theme-toggle{position:fixed;top:16px;right:16px;z-index:100;
    background:var(--card-bg);border:1px solid var(--card-border);color:var(--text);
    width:42px;height:42px;border-radius:50%;display:flex;align-items:center;justify-content:center;
    font-size:19px;cursor:pointer;box-shadow:var(--shadow)}
  .header{text-align:center;padding:36px 0 28px;opacity:0;animation:fadeUp .5s ease forwards}
  .header h1{font-family:'Space Grotesk',sans-serif;font-size:30px;font-weight:700;color:var(--text);margin-bottom:6px;letter-spacing:-.5px}
  .header p{color:var(--text-faint);font-size:14px}
  .search-box{background:var(--card-bg);border:1px solid var(--card-border);border-radius:16px;padding:20px;margin-bottom:24px;
    opacity:0;animation:fadeUp .5s ease .08s forwards}
  .search-box p{font-size:14px;color:var(--text-dim);margin-bottom:12px}
  .search-row{display:flex;gap:10px}
  .search-row input{flex:1;background:var(--input-bg);border:1px solid var(--input-border);color:var(--text);
    padding:13px 14px;border-radius:10px;font-size:14px;outline:none;font-family:'JetBrains Mono',monospace;transition:border-color .15s}
  .search-row input:focus{border-color:#2563eb}
  .search-row button{background:#2563eb;color:#fff;border:none;
    padding:13px 20px;border-radius:10px;font-size:14px;font-weight:600;cursor:pointer;white-space:nowrap;transition:.15s}
  .search-row button:hover{background:#1d4ed8;transform:translateY(-1px)}
  .card-grid{display:grid;grid-template-columns:1fr;gap:16px}
  @media(min-width:680px){.card-grid{grid-template-columns:1fr 1fr}}
  .card{background:var(--card-bg);border:1px solid var(--card-border);border-radius:16px;padding:22px;
    opacity:0;animation:fadeUp .5s ease forwards;transition:transform .15s,box-shadow .15s}
  .card:hover{transform:translateY(-2px);box-shadow:var(--shadow)}
  .card:nth-of-type(1){animation-delay:.14s}
  .card:nth-of-type(2){animation-delay:.2s}
  .card:nth-of-type(3){animation-delay:.26s}
  .card:nth-of-type(4){animation-delay:.32s}
  .card-title{display:flex;align-items:center;gap:10px;font-family:'Space Grotesk',sans-serif;font-size:19px;font-weight:700;color:var(--text);margin-bottom:8px}
  .card-title .icon{font-size:22px}
  .card-desc{color:var(--text-dim);font-size:14px;margin-bottom:16px;line-height:1.6}
  .code-block{background:var(--code-bg);border-radius:10px;padding:14px 16px;font-family:'JetBrains Mono',monospace;font-size:13px;margin-bottom:10px}
  .code-block .method{color:#3fb950}
  .code-block .path{color:var(--text)}
  .code-block .param{color:#e3b341}
  .example-label{color:var(--text-faint);font-size:12px;margin-bottom:4px}
  .example-link{color:#58a6ff;font-size:13px;text-decoration:none;font-family:'JetBrains Mono',monospace}
  .example-link:hover{text-decoration:underline}
  .divider{border:none;border-top:1px solid var(--card-border);margin:8px 0 14px}
  .health-row{display:flex;align-items:center;gap:8px;font-size:13px}
  .dot{width:8px;height:8px;border-radius:50%;background:#3fb950;flex-shrink:0;box-shadow:0 0 0 0 rgba(63,185,80,.5);animation:pulse 2s infinite}
  .health-code{background:var(--code-bg);border-radius:8px;padding:10px 14px;font-family:'JetBrains Mono',monospace;font-size:13px;color:#58a6ff;margin-top:10px}
  .badge{display:inline-block;background:#0d2137;color:#58a6ff;font-size:11px;padding:2px 8px;border-radius:20px;margin-left:6px;vertical-align:middle;font-family:'Inter',sans-serif}
  @keyframes fadeUp{from{opacity:0;transform:translateY(10px)}to{opacity:1;transform:translateY(0)}}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(63,185,80,.5)}70%{box-shadow:0 0 0 6px rgba(63,185,80,0)}100%{box-shadow:0 0 0 0 rgba(63,185,80,0)}}
  @media(prefers-reduced-motion:reduce){.header,.search-box,.card{animation:none;opacity:1}.dot{animation:none}}
  /* Feature badges */
  .feature-row{display:flex;flex-wrap:wrap;gap:20px 28px;justify-content:center;margin-bottom:24px;
    opacity:0;animation:fadeUp .5s ease .1s forwards}
  .feature-item{display:flex;align-items:center;gap:8px;color:var(--text-dim);font-size:14.5px;font-weight:500}
  .feature-item .ico{font-size:17px}
  /* Highlight cards (marketing) */
  .highlight-card{background:var(--card-bg);border:1px solid var(--card-border);border-radius:16px;
    padding:26px;margin-bottom:16px;opacity:0;animation:fadeUp .5s ease forwards;transition:transform .15s,box-shadow .15s}
  .highlight-card:hover{transform:translateY(-2px);box-shadow:var(--shadow)}
  .highlight-card:nth-of-type(1){animation-delay:.16s}
  .highlight-card:nth-of-type(2){animation-delay:.22s}
  .highlight-icon{width:52px;height:52px;border-radius:14px;background:rgba(37,99,235,.12);
    display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:16px}
  .highlight-card h2{font-family:'Space Grotesk',sans-serif;font-size:21px;font-weight:700;color:var(--text);margin-bottom:10px}
  .highlight-card p{color:var(--text-dim);font-size:14.5px;line-height:1.7}
  /* How it works */
  .steps-section{background:var(--card-bg);border:1px solid var(--card-border);border-radius:16px;
    padding:24px 22px;margin-bottom:24px;opacity:0;animation:fadeUp .5s ease .3s forwards}
  .steps-section h2{font-family:'Space Grotesk',sans-serif;font-size:19px;font-weight:700;color:var(--text);margin-bottom:18px}
  .step{display:flex;gap:14px;margin-bottom:18px}
  .step:last-child{margin-bottom:0}
  .step-num{width:26px;height:26px;border-radius:50%;background:#2563eb;color:#fff;
    display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:700;flex-shrink:0;margin-top:1px}
  .step-body strong{color:var(--text);font-size:15px}
  .step-body p{color:var(--text-dim);font-size:13.5px;line-height:1.6;margin-top:3px}
  /* Verification warning */
  .verify-box{background:rgba(120,53,15,.18);border:1px solid rgba(217,119,6,.5);border-radius:14px;
    padding:18px 20px;margin-bottom:24px;opacity:0;animation:fadeUp .5s ease .12s forwards}
  .verify-box p{display:flex;align-items:flex-start;gap:10px;color:#fcd9a8;font-size:14px;line-height:1.6;margin-bottom:14px}
  .verify-box p .ico{font-size:17px;flex-shrink:0;margin-top:1px}
  .verify-btn{display:inline-flex;align-items:center;gap:6px;background:#d97706;color:#fff;
    padding:11px 20px;border-radius:24px;font-size:14px;font-weight:700;text-decoration:none;
    transition:.15s;border:none;cursor:pointer}
  .verify-btn:hover{background:#b45309;transform:translateY(-1px)}
  /* Recently Watched */
  .history-section{margin-bottom:24px;opacity:0;animation:fadeUp .5s ease .12s forwards}
  .history-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}
  .history-head h2{font-family:'Space Grotesk',sans-serif;font-size:17px;font-weight:700;color:var(--text)}
  .history-clear{background:none;border:none;color:var(--text-faint);font-size:12.5px;cursor:pointer;text-decoration:underline}
  .history-clear:hover{color:var(--text-dim)}
  .history-list{display:flex;flex-direction:column;gap:8px}
  .history-item{display:flex;align-items:center;gap:12px;background:var(--card-bg);border:1px solid var(--card-border);
    border-radius:12px;padding:10px 12px;cursor:pointer;transition:.15s;text-decoration:none;color:inherit}
  .history-item:hover{transform:translateY(-1px);box-shadow:var(--shadow)}
  .history-thumb{width:44px;height:44px;border-radius:8px;object-fit:cover;background:var(--input-bg);flex-shrink:0}
  .history-thumb-fallback{width:44px;height:44px;border-radius:8px;background:var(--input-bg);flex-shrink:0;
    display:flex;align-items:center;justify-content:center;font-size:18px}
  .history-info{flex:1;min-width:0}
  .history-title{font-size:13.5px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
  .history-meta{font-size:11.5px;color:var(--text-faint);margin-top:2px}
  .history-remove{background:none;border:none;color:var(--text-faint);font-size:16px;cursor:pointer;padding:4px 6px;flex-shrink:0}
  .history-remove:hover{color:#ef4444}
  /* Disclaimer */
  .disclaimer-box{background:var(--card-bg);border:1px solid var(--card-border);border-radius:14px;
    padding:18px 20px;color:var(--text-faint);font-size:12.5px;line-height:1.7;margin-top:24px}
  .disclaimer-box strong{color:var(--text-dim)}
</style>
</head>
<body>
<button class="theme-toggle" id="themeToggle" onclick="toggleTheme()" title="Toggle dark/light mode">🌙</button>
<div class="container">

  <div class="header">
    <h1>⚡ AK Clouds</h1>
    <p>Terabox API &amp; Media Player</p>
  </div>

  <div class="search-box">
    <p>Paste a Terabox link or file ID to stream instantly</p>
    <div class="search-row">
      <input type="text" id="streamInput" placeholder="e.g. 1B8O4ok3QPjtucizhZ36QyA" autocomplete="off">
      <button onclick="goStream()">▶ Play</button>
    </div>
  </div>

  <div class="verify-box">
    <p><span class="ico">⚠️</span> Seeing "higher qualities unavailable"? Your Terabox account may need re-verification.</p>
    <a class="verify-btn" href="https://www.terabox.com/main" target="_blank" rel="noopener">Verify on Terabox ↗</a>
  </div>

  <div class="history-section" id="historySection" style="display:none">
    <div class="history-head">
      <h2>🕘 Recently Watched</h2>
      <button class="history-clear" onclick="clearHistory()">Clear all</button>
    </div>
    <div class="history-list" id="historyList"></div>
  </div>

  <div class="feature-row">
    <div class="feature-item"><span class="ico">👁️</span> Faster Stream</div>
    <div class="feature-item"><span class="ico">🛡️</span> Secure Playback</div>
    <div class="feature-item"><span class="ico">⚡</span> Low Latency</div>
  </div>

  <div class="highlight-card">
    <div class="highlight-icon">👑</div>
    <h2>Built for Terabox Playback</h2>
    <p>AK Clouds streams Terabox videos through a tuned HLS pipeline — fast start, adaptive quality switching, and a playback path built to avoid the stalls that come from hitting Terabox's CDN directly.</p>
  </div>

  <div class="highlight-card">
    <div class="highlight-icon">♿</div>
    <h2>Works Everywhere</h2>
    <p>Every link works as both an HLS (M3U8) stream and a direct file download, so it plays cleanly in the browser, in MX Player, VLC, PlayIt, or whatever app you hand it to.</p>
  </div>

  <div class="steps-section">
    <h2>How It Works</h2>
    <div class="step">
      <div class="step-num">1</div>
      <div class="step-body"><strong>Copy the Terabox link</strong><p>Grab the share link from the Terabox app or website.</p></div>
    </div>
    <div class="step">
      <div class="step-num">2</div>
      <div class="step-body"><strong>Paste it above</strong><p>Drop the link or file ID into the box and hit Play.</p></div>
    </div>
    <div class="step">
      <div class="step-num">3</div>
      <div class="step-body"><strong>Stream or download</strong><p>Watch instantly, or grab the file in your preferred quality.</p></div>
    </div>
  </div>

  <div class="card-grid">
  <div class="card">
    <div class="card-title"><span class="icon">&lt;/&gt;</span> API Endpoint <span class="badge">JSON</span></div>
    <div class="card-desc">Get direct download links and metadata in JSON.</div>
    <div class="code-block">
      <span class="method">GET</span> <span class="path">/api?url=</span><span class="param">ID_OR_LINK</span>
    </div>
    <div class="example-label">Example:</div>
    <a class="example-link" href="/api?url=1B8O4ok3QPjtucizhZ36QyA">/api?url=1B8O4ok3QPjtucizhZ36QyA</a>
  </div>

  <div class="card">
    <div class="card-title"><span class="icon">▶</span> Media Player <span class="badge">HLS</span></div>
    <div class="card-desc">Stream videos/audio with HLS fast mode.</div>
    <div class="code-block">
      <span class="method">GET</span> <span class="path">/play?url=</span><span class="param">ID_OR_LINK</span>
    </div>
    <div class="example-label">Example:</div>
    <a class="example-link" href="/play?url=1B8O4ok3QPjtucizhZ36QyA">/play?url=1B8O4ok3QPjtucizhZ36QyA</a>
  </div>

  <div class="card">
    <div class="card-title"><span class="icon">⬇</span> Download <span class="badge">FILE</span></div>
    <div class="card-desc">Direct file download — resolves the link and redirects straight to the file.</div>
    <div class="code-block">
      <span class="method">GET</span> <span class="path">/download?url=</span><span class="param">ID_OR_LINK</span>
    </div>
    <div class="example-label">Example:</div>
    <a class="example-link" href="/download?url=1B8O4ok3QPjtucizhZ36QyA">/download?url=1B8O4ok3QPjtucizhZ36QyA</a>
  </div>

  <div class="card">
    <div class="card-title"><span class="icon">🟢</span> Status</div>
    <hr class="divider">
    <div class="health-row"><span class="dot"></span> Server is running</div>
    <div class="health-code">GET /health</div>
  </div>
  </div>

  <div class="disclaimer-box">
    <strong>Disclaimer:</strong> AK Clouds is an independent, unofficial tool and is not affiliated with, endorsed by, or connected to Terabox or Dubox in any way. All trademarks belong to their respective owners.
  </div>

</div>
<script>
  function goStream() {
    const v = document.getElementById('streamInput').value.trim();
    if (!v) return;
    window.location.href = '/play?url=' + encodeURIComponent(v);
  }
  document.getElementById('streamInput').addEventListener('keydown', function(e) {
    if (e.key === 'Enter') goStream();
  });

  // Recently Watched — reads the same localStorage key /play writes to.
  // Escaping is required here: a video's file_name is attacker-controllable
  // (whoever uploaded/shared the Terabox file), gets stored as-is in
  // localStorage by the player, and would otherwise be injected into
  // innerHTML unescaped here.
  const HISTORY_KEY = 'akclouds_history';
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }
  function loadHistory() {
    try {
      const list = JSON.parse(localStorage.getItem(HISTORY_KEY) || '[]');
      return Array.isArray(list) ? list : [];
    } catch { return []; }
  }
  function renderHistory() {
    const section = document.getElementById('historySection');
    const listEl = document.getElementById('historyList');
    const list = loadHistory();
    if (!list.length) { section.style.display = 'none'; return; }
    section.style.display = '';
    listEl.innerHTML = list.map((item, i) => {
      const thumb = item.thumb
        ? '<img class="history-thumb" src="' + escapeHtml(item.thumb) + '" loading="lazy" onerror="this.style.display=\\'none\\'">'
        : '<div class="history-thumb-fallback">🎬</div>';
      return '<a class="history-item" href="/play?url=' + encodeURIComponent(item.url) + '">' +
        thumb +
        '<div class="history-info">' +
          '<div class="history-title">' + escapeHtml(item.title || 'Untitled') + '</div>' +
          '<div class="history-meta">' + escapeHtml(item.size || '') + '</div>' +
        '</div>' +
        '<button class="history-remove" onclick="event.preventDefault();event.stopPropagation();removeHistoryItem(' + i + ')" title="Remove">✕</button>' +
      '</a>';
    }).join('');
  }
  function removeHistoryItem(i) {
    const list = loadHistory();
    list.splice(i, 1);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(list)); } catch {}
    renderHistory();
  }
  function clearHistory() {
    try { localStorage.removeItem(HISTORY_KEY); } catch {}
    renderHistory();
  }
  renderHistory();

  // Theme toggle — shared convention with /play (same localStorage key so
  // the preference is consistent across both pages).
  function applyTheme(mode) {
    document.documentElement.setAttribute('data-theme', mode);
    const btn = document.getElementById('themeToggle');
    if (btn) btn.textContent = mode === 'light' ? '☀️' : '🌙';
  }
  function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
    const next = current === 'light' ? 'dark' : 'light';
    applyTheme(next);
    try { localStorage.setItem('akclouds_theme', next); } catch {}
  }
  (function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('akclouds_theme'); } catch {}
    applyTheme(saved === 'light' ? 'light' : 'dark');
  })();
</script>
</body></html>`, { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders } });
    }

    // ── /api ──────────────────────────────────────────────────────────────────
    if (path === "/api") {
      let rawUrl = url.searchParams.get("url");
      if (!rawUrl && request.method === "POST") {
        try { rawUrl = (await request.json()).url; } catch {}
      }

      if (!rawUrl?.trim()) {
        return jsonResp({
          status: "error",
          message: "url parameter required",
          usage: { get: "/api?url=ID_OR_LINK", post: '{ "url": "..." }' },
        }, 400);
      }
      rawUrl = rawUrl.trim();

      const cookieStr = await buildCookie(env);
      if (!cookieStr) {
        return jsonResp({
          status: "error",
          message: "Server not configured: NDUS secret missing",
        }, 500);
      }

      if (!isKnownTeraboxHost(rawUrl)) {
        return jsonResp({ status: "error", message: "Not a recognized Terabox domain", url: rawUrl }, 400);
      }
      const surl = resolveSurl(rawUrl);
      if (!surl) {
        return jsonResp({ status: "error", message: "Could not resolve surl/ID from input", url: rawUrl }, 400);
      }

      const cacheKey = `tb:${url.origin}:${surl}`;
      const cached   = cache.get(cacheKey);
      if (cached && Date.now() < cached.expiry) {
        return jsonResp({ status: "success", cached: true, ...cached.data });
      }

      const startTime = Date.now();
      try {
        const result = await fetchTeraboxDataWithRetry(surl, cookieStr, url.origin, env);
        if (result.error) {
          return jsonResp({
            status: "error",
            message: `Failed to retrieve download links: ${result.error}`,
            url: rawUrl,
          }, 400);
        }

        const responseTime = ((Date.now() - startTime) / 1000).toFixed(3) + "s";
        const data = {
          file_count: result.files.length,
          files:      result.files,
          folders:    result.folders,
          domain:     result.domain,
          response_time: responseTime,
        };
        if (result.possibly_truncated) {
          data.warning = "This share returned the maximum 500 items in one or more folders — there may be more files that weren't listed.";
        }
        if (result.files.some(f => f.verification_needed)) {
          data.account_warning = "Terabox is asking the configured account to complete a verification challenge (errno 400141) before it will serve higher-quality streams. Log into Terabox in a real browser using the same NDUS account and complete the verification, then retry. Lower qualities that were already fetched successfully are unaffected.";
        }

        cache.set(cacheKey, { data, expiry: Date.now() + CACHE_TTL });
        return jsonResp({ status: "success", cached: false, ...data });

      } catch (e) {
        return jsonResp({ status: "error", message: String(e), url: rawUrl }, 500);
      }
    }

    // ── /play ─────────────────────────────────────────────────────────────────
    if (path === "/play") {
      const rawUrl = url.searchParams.get("url");
      if (!rawUrl?.trim()) {
        return new Response("url parameter required", { status: 400, headers: corsHeaders });
      }

      const cookieStr = await buildCookie(env);
      if (!cookieStr) {
        return new Response("Server not configured: NDUS secret missing", { status: 500, headers: corsHeaders });
      }

      if (!isKnownTeraboxHost(rawUrl)) {
        return new Response("Not a recognized Terabox domain", { status: 400, headers: corsHeaders });
      }
      const surl = resolveSurl(rawUrl.trim());
      if (!surl) {
        return new Response("Could not resolve surl/ID from input", { status: 400, headers: corsHeaders });
      }

      try {
        const cacheKey = `tb:${url.origin}:${surl}`;
        let files;
        const cached = cache.get(cacheKey);
        if (cached && Date.now() < cached.expiry) {
          files = cached.data.files;
        } else {
          const result = await fetchTeraboxDataWithRetry(surl, cookieStr, url.origin, env);
          if (result.error) {
            return new Response(`Error: ${result.error}`, { status: 400, headers: corsHeaders });
          }
          files = result.files;
          cache.set(cacheKey, {
            data: { files, folders: result.folders, domain: result.domain },
            expiry: Date.now() + CACHE_TTL,
          });
        }

        const playable = files.find(f => f.file_type === "video") || files[0];
        if (!playable) {
          return new Response("No playable file found in this link", { status: 404, headers: corsHeaders });
        }

        // Pre-check: same priority order buildPlayerHTML uses to pick the
        // default quality — check THAT one playlist before ever handing
        // an HLS url to the browser. If Terabox served its short ~30s
        // preview instead of the real stream, skip HLS entirely for this
        // play so the browser goes straight to the original full file —
        // no truncated clip is ever shown, not even briefly.
        let playableForPlayer = playable;
        const HLS_CHECK_PRIORITY = ["480p", "360p", "720p", "1080p", "4K"];
        const checkUrl = playable.fast_stream_url
          ? HLS_CHECK_PRIORITY.map(q => playable.fast_stream_url[q]).find(Boolean)
          : null;
        if (checkUrl && playable.download_link) {
          try {
            const ac = new AbortController();
            const t = setTimeout(() => ac.abort(), 5000);
            const checkHost = new URL(checkUrl).hostname;
            const plResp = await fetch(checkUrl, {
              headers: { "User-Agent": UA, "Cookie": cookieStr, "Referer": `https://${checkHost}/` },
              signal: ac.signal,
            }).finally(() => clearTimeout(t));
            const plText = (await plResp.text()).replace(/^\uFEFF/, "");
            if (plText.startsWith("#EXTM3U")) {
              const playlistDuration = sumExtinfDuration(plText);
              const realDuration = playable.duration_seconds || 0;
              const isTruncated = realDuration > 0
                ? (playlistDuration > 0 && realDuration - playlistDuration > 10 && playlistDuration < realDuration * 0.7)
                : (playlistDuration > 0 && playlistDuration < 45);
              if (isTruncated) {
                playableForPlayer = { ...playable, fast_stream_url: null };
              }
            }
          } catch {
            // Pre-check failed (timeout/network) — fall through and let the
            // existing client-side + /hls-proxy server-side checks handle it.
          }
        }

        return new Response(buildPlayerHTML(playableForPlayer, url.origin, rawUrl.trim()), {
          headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders },
        });

      } catch (e) {
        return new Response(`Error: ${e}`, { status: 500, headers: corsHeaders });
      }
    }

    // ── /hls-proxy — proxy the m3u8 PLAYLIST with the server's cookie ───────────
    // HLS.js was previously given the raw Terabox share/streaming URL and
    // fetched it directly from the visitor's browser, which has no NDUS
    // cookie — Terabox then rejected it, showing up in the player as a
    // generic "network error / link expired" on every single link. This
    // route fetches the playlist here (with the cookie) and rewrites every
    // segment URI to go through /hls-seg, so the browser never talks to
    // Terabox directly.
    if (path === "/hls-proxy") {
      const m3u8Url = url.searchParams.get("url");
      // Same duration-mismatch inputs as /download-hls, but here the
      // consumer can be ANY HLS client — this page's own player, or an
      // external app (VLC/MX/PlayIt) that was handed the raw /hls-proxy
      // link via "Copy URL" / an intent launch. Those external players
      // never run this page's JS, so the browser-side MANIFEST_PARSED
      // check can't help them — this server-side check is what catches a
      // truncated playlist for them.
      const realDuration = Number(url.searchParams.get("real_duration") || 0);
      const fallbackUrl = url.searchParams.get("fallback");
      if (!m3u8Url) {
        return jsonResp({ status: "error", message: "url parameter required" }, 400);
      }

      let m3u8Host;
      try {
        m3u8Host = new URL(m3u8Url).hostname;
      } catch {
        return jsonResp({ status: "error", message: "Invalid url" }, 400);
      }
      if (!isAllowedStreamingHost(m3u8Host)) {
        return jsonResp({ status: "error", message: "Host not allowed", host: m3u8Host }, 400);
      }

      const cookieStr = await buildCookie(env);
      if (!cookieStr) {
        return jsonResp({ status: "error", message: "Server not configured: NDUS secret missing" }, 500);
      }

      const fwdHeaders = {
        "User-Agent": UA, "Cookie": cookieStr,
        "Referer": `https://${m3u8Host}/`, "Accept": "*/*",
      };

      try {
        const plResp = await fetch(m3u8Url, { headers: fwdHeaders });
        const playlistText = (await plResp.text()).replace(/^\uFEFF/, "");

        if (!playlistText.startsWith("#EXTM3U")) {
          // Terabox returned an error body (expired sign, needs-verify JSON,
          // etc.) instead of a playlist — surface that clearly instead of
          // handing HLS.js garbage to fail on silently.
          return jsonResp({
            status: "error",
            message: "Playlist is no longer valid (expired, signature error, or account needs verification) — re-fetch /api for a fresh link.",
            upstream_status: plResp.status,
            preview: playlistText.slice(0, 300),
          }, 502);
        }

        // ── Truncated-playlist detection (external players) ─────────────────
        // Same EXTINF-sum check as /download-hls, done here so VLC/MX/PlayIt
        // — which fetch this URL directly and skip this page's JS entirely —
        // also get redirected straight to the full original file instead of
        // getting stuck on a ~30s preview with no way to detect it themselves.
        if (realDuration > 0 && fallbackUrl) {
          const playlistDuration = playlistText
            .split("\n")
            .filter(l => l.startsWith("#EXTINF:"))
            .reduce((sum, l) => {
              const v = parseFloat(l.slice("#EXTINF:".length));
              return sum + (Number.isFinite(v) ? v : 0);
            }, 0);

          const isTruncated =
            playlistDuration > 0 &&
            realDuration - playlistDuration > 10 &&
            playlistDuration < realDuration * 0.7;

          if (isTruncated) {
            try {
              const fbHost = new URL(fallbackUrl).hostname.toLowerCase();
              const CDN_SUFFIXES = ["terabox.com", "1024terabox.com", "1024tera.com", "terabox.app", "nephobox.com", "4funbox.com", "mirrobox.com", "freeterabox.com", "tibibox.com", "gibibox.com"];
              const fbAllowed =
                TERABOX_DOMAINS.some(d => fbHost === d || fbHost.endsWith("." + d)) ||
                CDN_SUFFIXES.some(d => fbHost === d || fbHost.endsWith("." + d));
              // Redirect straight to the proxied direct-file route (adds the
              // NDUS cookie + Range support) rather than the raw Terabox
              // link, so external players can actually play/seek it.
              if (fbAllowed) {
                const fbParams = new URLSearchParams();
                fbParams.set("dlink", fallbackUrl);
                fbParams.set("name", "video");
                return Response.redirect(`${url.origin}/download?${fbParams.toString()}`, 302);
              }
            } catch {}
            // Invalid/disallowed fallback host — fall through and serve the
            // (truncated) playlist rather than erroring out entirely.
          }
        }

        // Rewrite every non-comment line (segment or nested sub-playlist) to
        // go through this Worker instead of straight to Terabox.
        const segmentLines = playlistText
          .split("\n")
          .map(l => l.trim())
          .filter(l => l && !l.startsWith("#"));

        const rewritten = playlistText
          .split("\n")
          .map(line => {
            const trimmed = line.trim();
            if (!trimmed || trimmed.startsWith("#")) return line;
            let abs;
            try { abs = new URL(trimmed, m3u8Url).toString(); } catch { return line; }
            return abs.includes(".m3u8")
              ? buildHlsProxyUrl(url.origin, abs)
              : buildHlsSegUrl(url.origin, abs);
          })
          .join("\n");

        // Warm the edge cache for the first few segments RIGHT NOW, in the
        // background — without this, HLS.js requests segment 1 the moment
        // the player attaches, hits an edge cache MISS, and pays the full
        // Worker->Terabox round-trip before a single frame can play. By
        // firing these fetches immediately (same cf.cacheEverything key as
        // /hls-seg uses) via ctx.waitUntil, the cache is very likely already
        // warm by the time the player's real request lands a few hundred ms
        // later — that's the difference between "instant start" (apps) and
        // a visible stall on the very first segment.
        const PREFETCH_COUNT = 8;
        const toPrefetch = segmentLines
          .filter(l => !l.includes(".m3u8")) // only actual segments, not nested playlists
          .slice(0, PREFETCH_COUNT);
        if (toPrefetch.length) {
          ctx.waitUntil(Promise.all(toPrefetch.map(seg => {
            let abs;
            try { abs = new URL(seg, m3u8Url).toString(); } catch { return Promise.resolve(); }
            return fetch(abs, {
              headers: fwdHeaders,
              cf: { cacheTtl: 3600, cacheEverything: true },
            }).catch(() => {}); // best-effort — a failed prefetch just means no warm cache, not an error
          })));
        }

        return new Response(rewritten, {
          headers: {
            "Content-Type": "application/vnd.apple.mpegurl",
            "Cache-Control": "no-store",
            ...corsHeaders,
          },
        });
      } catch (e) {
        return jsonResp({ status: "error", message: `Failed to fetch playlist: ${e.message || e}` }, 502);
      }
    }

    // ── /subtitle-proxy — proxy a subtitle file (VTT/SRT) with the server's cookie ──
    // Same reasoning as /hls-seg: the browser's <track> element has no NDUS
    // cookie and Terabox sends no CORS header on these files, so fetching
    // them directly from the visitor's browser fails. Route through here so
    // the cookie is attached server-side and the response carries CORS.
    if (path === "/subtitle-proxy") {
      const subUrl = url.searchParams.get("url");
      if (!subUrl) {
        return jsonResp({ status: "error", message: "url parameter required" }, 400);
      }

      let subHost;
      try {
        subHost = new URL(subUrl).hostname;
      } catch {
        return jsonResp({ status: "error", message: "Invalid url" }, 400);
      }
      if (!isAllowedStreamingHost(subHost)) {
        return jsonResp({ status: "error", message: "Host not allowed", host: subHost }, 400);
      }

      const cookieStr = await buildCookie(env);
      if (!cookieStr) {
        return jsonResp({ status: "error", message: "Server not configured: NDUS secret missing" }, 500);
      }

      try {
        const subResp = await fetch(subUrl, {
          headers: {
            "User-Agent": UA, "Cookie": cookieStr,
            "Referer": `https://${subHost}/`, "Accept": "*/*",
          },
          cf: { cacheTtl: 3600, cacheEverything: true }, // no client Range involved here — safe to cache unconditionally
        });
        if (!subResp.ok) {
          return jsonResp({ status: "error", message: `Upstream subtitle fetch failed (HTTP ${subResp.status})` }, 502);
        }
        const headers = new Headers(corsHeaders);
        // Browsers require an actual WebVTT Content-Type for <track> to load
        // it at all — Terabox may not send one, so force it. If the source
        // is actually SRT rather than VTT, browsers will silently fail to
        // parse it; there's no reliable way to tell the two apart from here
        // without inspecting the body, so this assumes VTT (the common case
        // for web playback).
        headers.set("Content-Type", "text/vtt; charset=utf-8");
        headers.set("Cache-Control", "public, max-age=3600");
        return new Response(subResp.body, { headers });
      } catch (e) {
        return jsonResp({ status: "error", message: `Subtitle proxy failed: ${e.message || e}` }, 502);
      }
    }

    // ── /hls-seg — proxy an individual .ts SEGMENT with the server's cookie ─────
    if (path === "/hls-seg") {
      const segUrl = url.searchParams.get("url");
      if (!segUrl) {
        return jsonResp({ status: "error", message: "url parameter required" }, 400);
      }

      let segHost;
      try {
        segHost = new URL(segUrl).hostname;
      } catch {
        return jsonResp({ status: "error", message: "Invalid url" }, 400);
      }
      if (!isAllowedStreamingHost(segHost)) {
        return jsonResp({ status: "error", message: "Host not allowed", host: segHost }, 400);
      }

      const cookieStr = await buildCookie(env);
      if (!cookieStr) {
        return jsonResp({ status: "error", message: "Server not configured: NDUS secret missing" }, 500);
      }

      const fwdHeaders = {
        "User-Agent": UA, "Cookie": cookieStr,
        "Referer": `https://${segHost}/`, "Accept": "*/*",
      };
      // Forward Range so HLS.js/native players can seek within a segment.
      const range = request.headers.get("Range");
      if (range) fwdHeaders["Range"] = range;

      try {
        // cf.cacheEverything lets Cloudflare's edge cache this segment (the
        // URL is unique per signed link, so caching it is safe and means
        // re-buffering, seeking backward, or a second viewer hitting the
        // same segment gets it from Cloudflare's edge instead of round-
        // tripping to Terabox every single time — this was previously
        // impossible because Cache-Control was hard-set to "no-store".
        //
        // IMPORTANT: only when there's no Range header. The edge cache key
        // here is just the URL — it does NOT vary by Range — so caching a
        // 206 partial response would mean a later request for a DIFFERENT
        // byte range of this same segment could be served the wrong cached
        // bytes. Full (non-Range) requests are always the same content, so
        // those are safe to cache.
        const segResp = await fetch(segUrl, {
          headers: fwdHeaders,
          cf: range ? {} : { cacheTtl: 3600, cacheEverything: true },
        });
        if (!segResp.ok && segResp.status !== 206) {
          return jsonResp({
            status: "error",
            message: `Upstream segment fetch failed (HTTP ${segResp.status}) — link may have expired, re-fetch /api.`,
          }, 502);
        }

        const headers = new Headers(corsHeaders);
        headers.set("Content-Type", segResp.headers.get("Content-Type") || "video/mp2t");
        const len = segResp.headers.get("Content-Length");
        if (len) headers.set("Content-Length", len);
        const cr = segResp.headers.get("Content-Range");
        if (cr) headers.set("Content-Range", cr);
        headers.set("Accept-Ranges", "bytes");
        // Was "no-store" — that blocked both the browser and Cloudflare's
        // edge from caching, forcing a fresh Terabox round-trip on every
        // rebuffer/seek. Segment URLs carry a unique signature per fetch,
        // so caching them for an hour (well under Terabox's ~8h expiry) is
        // safe and makes repeats near-instant.
        headers.set("Cache-Control", "public, max-age=3600");

        return new Response(segResp.body, { status: segResp.status, headers });
      } catch (e) {
        return jsonResp({ status: "error", message: `Segment proxy failed: ${e.message || e}` }, 502);
      }
    }

    // ── /download — proxy Terabox's dlink with correct headers ──────────────────
    // Browsers hitting dlink directly get 403 / redirect-loop because Terabox
    // hotlink-protects it (needs our User-Agent/Referer/cookie). We fetch it
    // server-side and stream the bytes back instead.
    if (path === "/download") {
      // NEW: /download?url=SHARE_LINK_OR_SURL_OR_ID
      // Lets people download without first knowing the raw `dlink` — same
      // input format as /play and /api. Resolves the share, picks the video
      // (or first file), and 302-redirects to that file's own
      // /download?dlink=...&name=... URL (which is what actually streams
      // the bytes, below).
      const rawUrl = url.searchParams.get("url");
      if (rawUrl?.trim() && !url.searchParams.get("dlink")) {
        const cookieStrForUrl = await buildCookie(env);
        if (!cookieStrForUrl) {
          return jsonResp({ status: "error", message: "Server not configured: NDUS secret missing" }, 500);
        }
        if (!isKnownTeraboxHost(rawUrl)) {
          return jsonResp({ status: "error", message: "Not a recognized Terabox domain", url: rawUrl }, 400);
        }
        const surl = resolveSurl(rawUrl.trim());
        if (!surl) {
          return jsonResp({ status: "error", message: "Could not resolve surl/ID from input", url: rawUrl }, 400);
        }
        try {
          const cacheKey = `tb:${url.origin}:${surl}`;
          let files;
          const cached = cache.get(cacheKey);
          if (cached && Date.now() < cached.expiry) {
            files = cached.data.files;
          } else {
            const result = await fetchTeraboxDataWithRetry(surl, cookieStrForUrl, url.origin, env);
            if (result.error) {
              return jsonResp({ status: "error", message: `Failed to retrieve download link: ${result.error}`, url: rawUrl }, 400);
            }
            files = result.files;
            cache.set(cacheKey, {
              data: { files, folders: result.folders, domain: result.domain },
              expiry: Date.now() + CACHE_TTL,
            });
          }

          // Optional ?name= or ?fs_id= to pick a specific file out of a
          // multi-file folder share; otherwise same "video, else first
          // file" pick that /play uses.
          const wantFsId = url.searchParams.get("fs_id");
          const wantName = url.searchParams.get("name");
          const picked =
            (wantFsId && files.find(f => String(f.fs_id) === String(wantFsId))) ||
            (wantName && files.find(f => f.file_name === wantName)) ||
            files.find(f => f.file_type === "video") ||
            files[0];

          if (!picked || !picked.download_link) {
            return jsonResp({ status: "error", message: "No downloadable file found in this link", url: rawUrl }, 404);
          }
          return Response.redirect(picked.download_link, 302);
        } catch (e) {
          return jsonResp({ status: "error", message: String(e), url: rawUrl }, 500);
        }
      }

      const dlink = url.searchParams.get("dlink");
      const rawName = url.searchParams.get("name") || "download";
      // Strip CR/LF and quotes so the filename can't break out of the
      // Content-Disposition header (header injection).
      const name = rawName.replace(/[\r\n"]/g, "").slice(0, 200) || "download";

      if (!dlink) {
        return jsonResp({ status: "error", message: "dlink parameter required" }, 400);
      }

      // SSRF guard: /download is a public route, so without this check anyone
      // could pass an arbitrary URL in `dlink` and use this worker as an open
      // proxy (e.g. to hit internal/cloud-metadata addresses) — it would even
      // attach our NDUS cookie to that request. Only allow hosts that are
      // Terabox's own domains or end in one of their known CDN suffixes.
      try {
        const dlinkHost = new URL(dlink).hostname.toLowerCase();
        const CDN_SUFFIXES = ["terabox.com", "1024terabox.com", "1024tera.com", "terabox.app", "nephobox.com", "4funbox.com", "mirrobox.com", "freeterabox.com", "tibibox.com", "gibibox.com"];
        const allowed =
          TERABOX_DOMAINS.some(d => dlinkHost === d || dlinkHost.endsWith("." + d)) ||
          CDN_SUFFIXES.some(d => dlinkHost === d || dlinkHost.endsWith("." + d));
        if (!allowed) {
          return jsonResp({ status: "error", message: "dlink host not allowed", host: dlinkHost }, 400);
        }
      } catch {
        return jsonResp({ status: "error", message: "Invalid dlink URL" }, 400);
      }

      const cookieStr = await buildCookie(env);
      if (!cookieStr) {
        return jsonResp({ status: "error", message: "Server not configured: NDUS secret missing" }, 500);
      }

      try {
        // Forward Range so video players can seek and download managers can resume —
        // without this, every request re-downloads the whole file from byte 0.
        const range = request.headers.get("Range");

        // ── Chunk-aligned edge caching for streaming (open-ended Range requests) ──
        // Video elements almost always send an OPEN range like "bytes=1234-"
        // (no explicit end) — the browser is saying "give me from here
        // onward, however much you want to send". That means we're free to
        // round the start down to a fixed block boundary and always hand
        // back exactly one RANGE_CHUNK_SIZE block, instead of proxying byte-
        // for-byte to Terabox on every single request. Each block gets its
        // own Cache API entry, so the SAME block requested again (by this
        // visitor scrubbing back, or by a different visitor watching the
        // same file) is served straight from Cloudflare's edge — no trip to
        // Terabox at all, which is what makes repeat/near plays feel instant
        // instead of re-buffering from scratch every time.
        //
        // Closed ranges (explicit "bytes=START-END", e.g. a tiny capability
        // probe some players send) are deliberately left on the old
        // byte-exact passthrough path below — chunk-rounding could return
        // more or fewer bytes than a client that hard-codes an exact length
        // is expecting.
        const openRangeMatch = /^bytes=(\d+)-$/.exec(range || "");
        if (openRangeMatch) {
          const RANGE_CHUNK_SIZE = 4 * 1024 * 1024; // 4MB blocks
          const reqStart = Number(openRangeMatch[1]);
          const chunkIndex = Math.floor(reqStart / RANGE_CHUNK_SIZE);
          const chunkStart = chunkIndex * RANGE_CHUNK_SIZE;
          const chunkEnd = chunkStart + RANGE_CHUNK_SIZE - 1;

          // dlink is already unique/signed per file, so it's a safe cache-key
          // base — we just tack on our own chunk index/size so each block
          // gets a distinct edge-cache entry (never sent to Terabox itself).
          const cacheKeyUrl = new URL(dlink);
          cacheKeyUrl.searchParams.set("_wchunk", String(chunkIndex));
          cacheKeyUrl.searchParams.set("_wsize", String(RANGE_CHUNK_SIZE));
          const cacheKey = new Request(cacheKeyUrl.toString(), { method: "GET" });
          const edgeCache = caches.default;

          const cached = await edgeCache.match(cacheKey);
          if (cached) {
            const headers = new Headers(cached.headers);
            for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
            return new Response(cached.body, { status: 206, headers });
          }

          const chunkResp = await fetchDlinkWithCookieRetry(dlink, {}, `bytes=${chunkStart}-${chunkEnd}`, env, cookieStr);

          if (!chunkResp || (!chunkResp.ok && chunkResp.status !== 206)) {
            return jsonResp({
              status: "error",
              message: `Upstream download failed (HTTP ${chunkResp?.status ?? "no response"}) after trying multiple cookies. The link may have expired — re-fetch /api for this file to get a fresh link.`,
            }, 502);
          }

          const buf = await chunkResp.arrayBuffer();
          const upstreamCR = chunkResp.headers.get("Content-Range");
          const blockHeaders = new Headers();
          blockHeaders.set("Content-Type", chunkResp.headers.get("Content-Type") || "video/mp4");
          blockHeaders.set("Accept-Ranges", "bytes");
          blockHeaders.set("Cache-Control", "public, max-age=3600");
          if (upstreamCR) blockHeaders.set("Content-Range", upstreamCR);
          blockHeaders.set("Content-Length", String(buf.byteLength));

          // Store this block at the edge in the background (doesn't delay
          // the response the visitor is waiting on), then answer immediately.
          ctx.waitUntil(edgeCache.put(cacheKey, new Response(buf.slice(0), { status: 206, headers: blockHeaders })));

          const outHeaders = new Headers(blockHeaders);
          for (const [k, v] of Object.entries(corsHeaders)) outHeaders.set(k, v);
          return new Response(buf, { status: 206, headers: outHeaders });
        }

        // Same edge-caching win as /hls-seg: the dlink is unique/signed per
        // file, so letting Cloudflare cache it (well under its ~8h expiry)
        // means a resumed download, a retried request, or a second person
        // downloading the same file gets served from the edge instead of
        // re-hitting Terabox every time.
        //
        // IMPORTANT: only cache full (non-Range) requests. The edge cache
        // key is the URL alone — it doesn't vary by Range — so caching a
        // 206 partial response risks a later request for a DIFFERENT byte
        // range being served these same (wrong) cached bytes. That would
        // silently corrupt video seeking/scrubbing and resumed downloads,
        // which are exactly the cases that send Range headers here.
        const upstream = await fetchDlinkWithCookieRetry(
          dlink, {}, range || null, env, cookieStr,
          range ? {} : { cacheTtl: 3600, cacheEverything: true }
        );

        if (!upstream || (!upstream.ok && upstream.status !== 206)) {

          // dlink is time-limited (expires within a few hours); a 403/404 here
          // most likely means it expired since being cached. Surface that clearly
          // instead of silently passing through a broken download.
          return jsonResp({
            status: "error",
            message: `Upstream download failed (HTTP ${upstream?.status ?? "no response"}) after trying multiple cookies. The link may have expired — re-fetch /api for this file to get a fresh link.`,
          }, 502);
        }

        // Terabox sometimes returns its error (e.g. expired/invalid cookie ->
        // {"error_code":31045,"error_msg":"user not exists"}) as an HTTP 200
        // with a small JSON body instead of an HTTP error status. Without this
        // check that JSON gets silently streamed to the browser disguised as
        // the video file (renamed .mkv etc), which is exactly what was happening.
        //
        // IMPORTANT: only run this check on a full-file request (no Range
        // header, status 200). Video/audio elements constantly issue small
        // Range requests while playing/seeking (e.g. a probe for the first
        // few hundred bytes) — those legitimately have a tiny Content-Length
        // because that's the size of the requested slice, not an error body.
        // Applying this check to 206 Partial Content responses was rejecting
        // real video bytes as a fake "JSON error" on nearly every range
        // request, which is what caused the constant reload/retry loop.
        const upstreamCT = upstream.headers.get("Content-Type") || "";
        const upstreamLen = Number(upstream.headers.get("Content-Length") || "0");
        const isPartial = upstream.status === 206 || !!range;
        if (!isPartial && (upstreamCT.includes("application/json") || (upstreamLen > 0 && upstreamLen < 1024))) {
          const peekText = await upstream.clone().text().catch(() => "");
          let errInfo = peekText.slice(0, 300);
          try {
            const j = JSON.parse(peekText);
            errInfo = `error_code=${j.error_code ?? j.errno ?? "?"} ${j.error_msg || j.errmsg || ""}`.trim();
          } catch {}
          return jsonResp({
            status: "error",
            message: `Terabox rejected the download (cookie likely expired/invalid): ${errInfo}`,
          }, 502);
        }

        const headers = new Headers(corsHeaders);
        headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/octet-stream");
        const len = upstream.headers.get("Content-Length");
        if (len) headers.set("Content-Length", len);
        const contentRange = upstream.headers.get("Content-Range");
        if (contentRange) headers.set("Content-Range", contentRange);
        headers.set("Accept-Ranges", "bytes");
        headers.set("Content-Disposition", `attachment; filename="${name}"`);
        headers.set("Cache-Control", "public, max-age=3600");

        return new Response(upstream.body, { status: upstream.status, headers });
      } catch (e) {
        return jsonResp({ status: "error", message: `Proxy fetch failed: ${e.message || e}` }, 502);
      }
    }

    // ── /download-hls — quality-specific download ───────────────────────────
    // /download proxies item.dlink, which is always the ORIGINAL uploaded
    // file — it never changes no matter which quality button is selected,
    // which is why "every quality downloads the same MB". The quality
    // buttons only ever fed the <video> player (HLS), never the download
    // link. This route makes the selected quality actually downloadable: it
    // reads that quality's m3u8 playlist, fetches each .ts segment in order
    // with the same auth headers, and pipes them out concatenated as one
    // file — streamed, not buffered in memory, so it works for large videos.
    if (path === "/download-hls") {
      const m3u8Url = url.searchParams.get("m3u8");
      const rawName = url.searchParams.get("name") || "video";
      const name = rawName.replace(/[\r\n"]/g, "").slice(0, 200) || "video";
      // Real file duration (seconds) from Terabox's own file metadata — used
      // below to detect a truncated HLS playlist. Optional: if the caller
      // didn't pass it, we simply skip the mismatch check.
      const realDuration = Number(url.searchParams.get("real_duration") || 0);
      // Where to send the user if the requested quality's playlist turns out
      // to be a truncated preview — normally the original full-file download
      // link (file.download_link), so the download still finishes at the
      // right length instead of silently cutting off at ~30s.
      const fallbackUrl = url.searchParams.get("fallback");

      if (!m3u8Url) {
        return jsonResp({ status: "error", message: "m3u8 parameter required" }, 400);
      }

      // Same SSRF guard as /download — only allow Terabox's own domains so
      // this can't be used as an open proxy.
      let m3u8Host;
      try {
        m3u8Host = new URL(m3u8Url).hostname.toLowerCase();
      } catch {
        return jsonResp({ status: "error", message: "Invalid m3u8 URL" }, 400);
      }
      const allowed =
        TERABOX_DOMAINS.some(d => m3u8Host === d || m3u8Host.endsWith("." + d)) ||
        STREAMING_DOMAINS.some(d => m3u8Host === d || m3u8Host.endsWith("." + d)) ||
        m3u8Host.endsWith(".terabox.app") || m3u8Host === "terabox.app";
      if (!allowed) {
        return jsonResp({ status: "error", message: "m3u8 host not allowed", host: m3u8Host }, 400);
      }

      const cookieStr = await buildCookie(env);
      if (!cookieStr) {
        return jsonResp({ status: "error", message: "Server not configured: NDUS secret missing" }, 500);
      }

      const fwdHeaders = {
        "User-Agent": UA, "Cookie": cookieStr,
        "Referer": `https://${m3u8Host}/`, "Accept": "*/*",
      };

      let playlistText;
      try {
        const plResp = await fetch(m3u8Url, { headers: fwdHeaders });
        playlistText = (await plResp.text()).replace(/^\uFEFF/, "");
        if (!playlistText.startsWith("#EXTM3U")) {
          return jsonResp({
            status: "error",
            message: "Playlist is no longer valid (expired or signature error) — re-fetch /api for a fresh link.",
          }, 502);
        }
      } catch (e) {
        return jsonResp({ status: "error", message: `Failed to fetch playlist: ${e.message || e}` }, 502);
      }

      // ── Truncated-playlist detection ──────────────────────────────────────
      // Terabox sometimes serves a short "preview" m3u8 (commonly ~30s) for a
      // given quality instead of the full-length one — the playlist itself is
      // perfectly valid HLS, so nothing above catches it. The only tell is
      // that its own #EXTINF total is much shorter than the file's real
      // duration. Sum the segment durations and compare against real_duration
      // (passed in from the file metadata); if this playlist is clearly a
      // truncated stand-in, redirect to the fallback (full original file)
      // instead of silently downloading a clipped .ts.
      if (realDuration > 0 && fallbackUrl) {
        const playlistDuration = playlistText
          .split("\n")
          .filter(l => l.startsWith("#EXTINF:"))
          .reduce((sum, l) => {
            const v = parseFloat(l.slice("#EXTINF:".length));
            return sum + (Number.isFinite(v) ? v : 0);
          }, 0);

        // Require both a meaningful absolute gap (>10s) and a large relative
        // gap (playlist under 70% of real length) before treating it as
        // truncated — avoids false positives from normal segment-duration
        // rounding on genuinely short clips.
        const isTruncated =
          playlistDuration > 0 &&
          realDuration - playlistDuration > 10 &&
          playlistDuration < realDuration * 0.7;

        if (isTruncated) {
          try {
            const fbHost = new URL(fallbackUrl).hostname.toLowerCase();
            const CDN_SUFFIXES = ["terabox.com", "1024terabox.com", "1024tera.com", "terabox.app", "nephobox.com", "4funbox.com", "mirrobox.com", "freeterabox.com", "tibibox.com", "gibibox.com"];
            const fbAllowed =
              TERABOX_DOMAINS.some(d => fbHost === d || fbHost.endsWith("." + d)) ||
              CDN_SUFFIXES.some(d => fbHost === d || fbHost.endsWith("." + d));
            if (fbAllowed) {
              const fbParams = new URLSearchParams();
              fbParams.set("dlink", fallbackUrl);
              fbParams.set("name", name.replace(/\.ts$/i, "") || "video");
              return Response.redirect(`${url.origin}/download?${fbParams.toString()}`, 302);
            }
          } catch {}
          // If the fallback URL is somehow invalid/disallowed, fall through
          // and serve the (truncated) HLS segments rather than erroring out.
        }
      }

      // Resolve each segment URI against the playlist URL (segments are
      // sometimes relative, sometimes absolute).
      const segmentUrls = playlistText
        .split("\n")
        .map(l => l.trim())
        .filter(l => l && !l.startsWith("#"))
        .map(l => { try { return new URL(l, m3u8Url).toString(); } catch { return null; } })
        .filter(Boolean);

      if (!segmentUrls.length) {
        return jsonResp({ status: "error", message: "Playlist contained no segments" }, 502);
      }

      // Stream segments out via a TransformStream so we never hold the
      // whole file in memory — this is what lets a 600MB+ video download
      // through a Worker without hitting memory limits.
      //
      // Segments are still WRITTEN in strict order (required — .ts
      // concatenation must stay sequential or the output is corrupt), but
      // fetches run in a sliding window of WINDOW segments in flight at
      // once instead of just one segment ahead. Fetching only 1-ahead means
      // total speed is capped at roughly (1 segment / round-trip time) —
      // with small .ts segments and normal CDN latency that lands you in
      // the low hundreds of KB/s no matter how fast the link actually is.
      // Running several requests in parallel and writing them out in order
      // lets the download saturate the actual connection instead of being
      // limited by per-request latency, which is what turns this into real
      // MB/s speeds.
      const WINDOW = 12; // concurrent in-flight segment fetches
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();

      // Fetch a segment with retry+backoff for transient failures only
      // (network hiccup, 429 too-many-requests, 5xx). This is just
      // resilience for a single request that already legitimately failed —
      // it does not change how many requests are in flight, so it doesn't
      // affect rate-limit exposure either way.
      async function fetchSegWithRetry(idx, attempt = 0) {
        try {
          const resp = await fetch(segmentUrls[idx], {
            headers: fwdHeaders,
            cf: { cacheTtl: 3600, cacheEverything: true },
          });
          if ((resp.status === 429 || resp.status >= 500) && attempt < 3) {
            await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt)));
            return fetchSegWithRetry(idx, attempt + 1);
          }
          return resp;
        } catch (e) {
          if (attempt < 3) {
            await new Promise(r => setTimeout(r, 300 * Math.pow(2, attempt)));
            return fetchSegWithRetry(idx, attempt + 1);
          }
          return { __error: e.message || String(e) };
        }
      }

      (async () => {
        const fetchSeg = (idx) => fetchSegWithRetry(idx);

        try {
          // Prime the window: kick off the first WINDOW fetches immediately.
          const inFlight = new Map();
          for (let i = 0; i < Math.min(WINDOW, segmentUrls.length); i++) {
            inFlight.set(i, fetchSeg(i));
          }

          for (let i = 0; i < segmentUrls.length; i++) {
            const segResp = await inFlight.get(i);
            inFlight.delete(i);

            // As soon as slot i is consumed, start fetching the next segment
            // that isn't already in flight, keeping the window full.
            const nextToQueue = i + WINDOW;
            if (nextToQueue < segmentUrls.length) {
              inFlight.set(nextToQueue, fetchSeg(nextToQueue));
            }

            if (segResp && segResp.__error) {
              await writer.abort(`Segment ${i} fetch failed: ${segResp.__error}`);
              return;
            }
            if (!segResp.ok || !segResp.body) {
              // A single failed segment shouldn't be silently skipped (that
              // would corrupt playback) — abort the whole download instead
              // of producing a file that looks complete but isn't.
              await writer.abort(`Segment ${i} failed: HTTP ${segResp.status}`);
              return;
            }
            const reader = segResp.body.getReader();
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              await writer.write(value);
            }
          }
          await writer.close();
        } catch (e) {
          await writer.abort(e.message || String(e));
        }
      })();

      const headers = new Headers(corsHeaders);
      headers.set("Content-Type", "video/mp2t");
      headers.set("Content-Disposition", `attachment; filename="${name}"`);
      return new Response(readable, { headers });
    }

    return jsonResp({ status: "error", message: "Not Found" }, 404);
  },
};