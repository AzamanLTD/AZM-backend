// src/config/publicAppUrl.js
// =============================================================================
// PUBLIC APP URL — the validated origin used to build canonical share URLs.
//
// Share URLs (e.g. the LINK payment-request landing page /request/:token) are
// minted by the SERVER and must never be derived from an untrusted request
// Host header (Host-header trust = open-redirect / phishing-link minting).
// The origin comes from configuration only:
//
//   PUBLIC_APP_URL   e.g. https://app.azaman.com   (production web app origin)
//
// Validation (fail honestly, never invent a default):
//   • must parse as http(s) URL
//   • must carry NO path, query or fragment (an origin only)
//   • https required outside test/development (http allowed only for
//     localhost/127.0.0.1 so local development and CI can run unauthenticated)
//
// Callers surface PUBLIC_APP_URL_UNCONFIGURED (503) when the setting is
// missing: a LINK request without a canonical origin would either mint a
// fabricated URL or leak trust into the Host header — both are worse than
// refusing the operation.
// =============================================================================

const { URL } = require('url');

const VALIDATION_ERROR = 'PUBLIC_APP_URL must be an http(s) origin without path/query/fragment (e.g. https://app.azaman.com).';

/**
 * Validate and normalise the configured public app origin.
 * @returns {{ ok: true, origin: string } | { ok: false, reason: 'MISSING' | 'INVALID', message: string }}
 */
function resolvePublicAppOrigin() {
  const raw = (process.env.PUBLIC_APP_URL || '').trim();

  if (!raw) {
    return {
      ok: false,
      reason: 'MISSING',
      message: 'PUBLIC_APP_URL is not configured; the server cannot mint canonical share links.',
    };
  }

  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: 'INVALID', message: VALIDATION_ERROR };
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: 'INVALID', message: VALIDATION_ERROR };
  }

  // An origin carries no path/query/fragment. URL parsers normalise a bare
  // origin to pathname '/' with empty search/hash — anything else means the
  // configured value is more than an origin.
  if (parsed.pathname !== '/' || parsed.search || parsed.hash) {
    return { ok: false, reason: 'INVALID', message: VALIDATION_ERROR };
  }

  const host = parsed.hostname;
  const isLoopback = host === 'localhost' || host === '127.0.0.1' || host === '::1';
  if (parsed.protocol === 'http:' && !isLoopback && process.env.NODE_ENV === 'production') {
    return {
      ok: false,
      reason: 'INVALID',
      message: 'PUBLIC_APP_URL must use https in production (http is only allowed for loopback hosts).',
    };
  }

  // Normalised: scheme://host[:port] with no trailing slash.
  const origin = `${parsed.protocol}//${parsed.host}`;
  return { ok: true, origin };
}

module.exports = { resolvePublicAppOrigin };
