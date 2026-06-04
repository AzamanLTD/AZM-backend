// =============================================================================
// LINK PREVIEW SERVICE — Phase UI-3 (2026-05-26)
//
// Server-side Open Graph metadata fetcher with persistent caching. Avoids
// client-side CORS, dedupes across users, and respects a 24h TTL via the
// LinkPreviewCache table.
//
// Public API:
//   • fetch(url)               — returns cached metadata or fetches fresh
//   • normaliseUrl(url)        — strips tracking params for stable hashing
//   • _hashUrl(url)            — sha256 of normalised URL
//
// Failure model:
//   • Network/timeout errors are cached as { status: 'FAILED' } for 1 hour
//     so we don't hammer dead URLs on every chat scroll.
//   • The cache row's `status` column lets the caller distinguish OK from
//     FAILED on read; the FE can choose to render a plain link if FAILED.
// =============================================================================

const crypto = require('crypto');

const CACHE_TTL_OK_MS     = 24 * 60 * 60 * 1000; // 24h for successful fetches
const CACHE_TTL_FAIL_MS   = 60 * 60 * 1000;      //  1h for failures (retry sooner)
const FETCH_TIMEOUT_MS    = 6000;                // hard 6s budget per URL
const MAX_HTML_BYTES      = 256 * 1024;          // cap to head + meta region
const USER_AGENT          = 'AzamanLinkPreviewBot/1.0 (+https://azaman.me)';

class LinkPreviewService {
    constructor(prisma) {
        this.prisma = prisma;
    }

    // ── Public ────────────────────────────────────────────────────────────────

    async fetch(url) {
        if (!url || typeof url !== 'string') {
            return null;
        }
        const normalised = this.normaliseUrl(url);
        if (!normalised) return null;
        const urlHash = this._hashUrl(normalised);

        // Cache lookup
        const cached = await this.prisma.linkPreviewCache.findUnique({
            where: { urlHash }
        });
        const now = Date.now();
        if (cached && cached.expiresAt.getTime() > now) {
            return this._toPayload(cached);
        }

        // Fresh fetch
        let metadata;
        try {
            metadata = await this._fetchMetadata(normalised);
        } catch (err) {
            metadata = { status: 'FAILED', error: err.message };
        }

        const expiresAt = new Date(
            now + (metadata.status === 'OK' ? CACHE_TTL_OK_MS : CACHE_TTL_FAIL_MS)
        );

        const row = await this.prisma.linkPreviewCache.upsert({
            where: { urlHash },
            create: {
                urlHash,
                url: normalised,
                title: metadata.title || null,
                description: metadata.description || null,
                image: metadata.image || null,
                favicon: metadata.favicon || null,
                siteName: metadata.siteName || null,
                status: metadata.status,
                fetchedAt: new Date(now),
                expiresAt
            },
            update: {
                url: normalised,
                title: metadata.title || null,
                description: metadata.description || null,
                image: metadata.image || null,
                favicon: metadata.favicon || null,
                siteName: metadata.siteName || null,
                status: metadata.status,
                fetchedAt: new Date(now),
                expiresAt
            }
        });

        return this._toPayload(row);
    }

    normaliseUrl(raw) {
        try {
            const u = new URL(raw.trim());
            if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
            // Strip the most common tracking params so two paths that differ
            // only by analytics garbage hash to the same cache row.
            const trackingParams = [
                'utm_source','utm_medium','utm_campaign','utm_term','utm_content',
                'gclid','fbclid','mc_cid','mc_eid','ref','ref_src','referrer'
            ];
            trackingParams.forEach((p) => u.searchParams.delete(p));
            // Lowercase host, drop fragment, sort search params for stability.
            u.hostname = u.hostname.toLowerCase();
            u.hash = '';
            u.searchParams.sort();
            return u.toString();
        } catch (_) {
            return null;
        }
    }

    // ── Internal ──────────────────────────────────────────────────────────────

    _hashUrl(url) {
        return crypto.createHash('sha256').update(url).digest('hex');
    }

    _toPayload(row) {
        return {
            url: row.url,
            title: row.title,
            description: row.description,
            image: row.image,
            favicon: row.favicon,
            siteName: row.siteName,
            status: row.status,
            fetchedAt: row.fetchedAt
        };
    }

    async _fetchMetadata(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
        try {
            const res = await fetch(url, {
                method: 'GET',
                redirect: 'follow',
                headers: {
                    'User-Agent': USER_AGENT,
                    'Accept': 'text/html,application/xhtml+xml',
                    'Accept-Language': 'en-US,en;q=0.5'
                },
                signal: controller.signal
            });
            if (!res.ok) {
                return { status: res.status === 403 || res.status === 401 ? 'BLOCKED' : 'FAILED' };
            }
            const contentType = (res.headers.get('content-type') || '').toLowerCase();
            if (!contentType.includes('html')) {
                // Direct image / file URL — synthesise a minimal preview.
                if (contentType.startsWith('image/')) {
                    return {
                        status: 'OK',
                        image: url,
                        siteName: this._hostFrom(url)
                    };
                }
                return { status: 'FAILED' };
            }

            // Read up to MAX_HTML_BYTES to capture <head>; full body not needed.
            const reader = res.body.getReader();
            const decoder = new TextDecoder('utf-8', { fatal: false });
            let html = '';
            let total = 0;
            // eslint-disable-next-line no-constant-condition
            while (true) {
                const { value, done } = await reader.read();
                if (done) break;
                total += value.byteLength;
                html += decoder.decode(value, { stream: true });
                if (total >= MAX_HTML_BYTES) {
                    try { reader.cancel(); } catch (_) { /* swallow */ }
                    break;
                }
            }

            const meta = this._parseHtml(html, url);
            return { status: 'OK', ...meta };
        } catch (err) {
            if (err.name === 'AbortError') return { status: 'TIMEOUT' };
            return { status: 'FAILED', error: err.message };
        } finally {
            clearTimeout(timer);
        }
    }

    _parseHtml(html, baseUrl) {
        const pick = (re) => {
            const m = html.match(re);
            return m ? this._decodeEntities(m[1].trim()) : null;
        };

        const ogTitle =
            pick(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i) ||
            pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:title["']/i);
        const twTitle =
            pick(/<meta[^>]+name=["']twitter:title["'][^>]+content=["']([^"']+)["']/i);
        const docTitle = pick(/<title[^>]*>([^<]+)<\/title>/i);

        const ogDesc =
            pick(/<meta[^>]+property=["']og:description["'][^>]+content=["']([^"']+)["']/i) ||
            pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:description["']/i);
        const twDesc =
            pick(/<meta[^>]+name=["']twitter:description["'][^>]+content=["']([^"']+)["']/i);
        const metaDesc =
            pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']+)["']/i) ||
            pick(/<meta[^>]+content=["']([^"']+)["'][^>]+name=["']description["']/i);

        const ogImg =
            pick(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
            pick(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
        const twImg =
            pick(/<meta[^>]+name=["']twitter:image["'][^>]+content=["']([^"']+)["']/i);

        const siteName =
            pick(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)["']/i) ||
            this._hostFrom(baseUrl);

        const favicon =
            pick(/<link[^>]+rel=["'](?:shortcut icon|icon|apple-touch-icon)["'][^>]+href=["']([^"']+)["']/i) ||
            pick(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["'](?:shortcut icon|icon|apple-touch-icon)["']/i);

        return {
            title: ogTitle || twTitle || docTitle,
            description: ogDesc || twDesc || metaDesc,
            image: this._absolutise(ogImg || twImg, baseUrl),
            favicon: this._absolutise(favicon, baseUrl),
            siteName
        };
    }

    _absolutise(maybeRelative, baseUrl) {
        if (!maybeRelative) return null;
        try {
            return new URL(maybeRelative, baseUrl).toString();
        } catch (_) {
            return null;
        }
    }

    _hostFrom(url) {
        try {
            return new URL(url).hostname;
        } catch (_) {
            return null;
        }
    }

    _decodeEntities(s) {
        if (!s) return s;
        return s
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/&nbsp;/g, ' ');
    }
}

module.exports = LinkPreviewService;
