# Firebase Admin replacement — security and compatibility review

**Date:** 2026-11-04
**Branch:** `exp/firebase-admin-replacement` (isolated, not wired into production)
**Reviewed head:** `602ea858fad0043139f34c0a27ddb7be4fdee049` (reviewed), fix landed at `b8006f7` and current head
**Production reference:** `main` @ `0edefa1dbe056343080f2d762d89a1b0936c109c`
**PR #384 head (unchanged):** `73109beabbe8cc362c6274963901043ce2d84678`

This review is source-based. Nothing here is an integration approval, and no
production file was modified.

## 1. Dependency blocker (reproduced, not inherited)

Clean `npm ci` on `73109be`, then `npm audit --omit=dev --audit-level=low`:
**4 moderate, 0 high, 0 low, 0 critical.**

| Advisory | Range | Path |
|---|---|---|
| GHSA-3g3m-2fjr-6pw4 | glob `>=9.0.0 <=14.0.1` | `rimraf/node_modules/glob@10.5.0` |
| GHSA-g3hv-75wg-m249 | minimatch `<11.0.1` | `rimraf/node_modules/minimatch@9.0.9` |
| — | rimraf `4.2.0 - 6.1.3` | via `google-gax@5.0.8` |
| — | google-gax `5.0.5 - 5.0.8` | via `@google-cloud/firestore@8.7.1` |

Single origin: `firebase-admin@14.3.0` → **optional** `@google-cloud/firestore@^8.7.1`
→ `google-gax@^5.0.1` → `rimraf@^5.0.1` → `glob@^10.3.7` → `minimatch@^9`.
No production code path calls Firestore; audit counts it because it reads the lockfile.

Rechecked 2026-11-04 with no upstream drift (firebase-admin 14.5.0, firestore 9.4.0,
google-gax 6.16.0, rimraf 6.1.4, glob 14.0.3, minimatch 11.0.4). The firestore 9
path is still blocked: `@google-cloud/firestore@9.4.0` pins
`@google-cloud/firestore-api@^0.2.0`, only `0.2.0` exists in that range, and it
requires `google-gax@^5.0.0`. There is no route to google-gax 6 from any
firebase-admin 14.x graph, so zero remains unreachable.

## 2. Verifier findings

### V2 (MEDIUM, fixed) — unknown `kid` drove one Google request per attempt
`resolve()` refetched on any unknown `kid` with no throttle. An attacker could
mint tokens with random kids and force a 1:1 outbound request to Google per
attempt, which is an amplification vector and could get egress rate-limited,
breaking logins for everyone. Fixed with a bounded forced-refresh interval
(`MIN_REFRESH_INTERVAL_MS`, 10s): rotation still works, amplification is capped.
Tests: rotation still picked up after the interval; 50 random kids cause zero
additional fetches.

### V3 (LOW, fixed) — no token size bound
`splitToken` accepted unbounded input and base64-decoded it before any check.
Express body limits cap this in practice, but defence in depth is cheap.
`MAX_TOKEN_LENGTH` (16 KiB) is enforced before parsing.

### V4 (LOW, fixed) — attacker-controlled `alg` echoed into the error
`'Unsupported algorithm: ' + String(header.alg)` let a hostile header inject
control characters or megabytes into a log line. Now sanitised and truncated.

### V5 (LOW, fixed) — local credential path was CWD-relative
Production resolves `path.join(__dirname, '../service-account.json')`, i.e. the
repo root, so a different working directory cannot change which file is read.
The PoC defaulted to a bare relative name. Now module-relative, with an absent
file treated as "no credential" rather than a crash.

### Verified safe (by reading source, not only tests)
- `alg` pinned to `RS256` and checked **before** key resolution; `none`, HS256,
  ES256 and algorithm confusion all refused. The verifier signs/verifies with an
  explicit `RSA-SHA256`, so a JWK cannot redirect the algorithm.
- Key selection bound to the token `kid`; only RSA keys with a non-empty kid,
  usable n/e, >=2048-bit modulus and no duplicate kid are admitted; one bad entry
  rejects the whole set.
- JWKS only from the pinned Google endpoint; TLS via Node's default trust store.
  The URL is not caller-supplied in production use.
- `iss` and `aud` are exact, project-scoped string comparisons. (Firebase Admin
  itself uses `payload.aud.includes(audience)`, which is looser; this is stricter.)
- `exp` matches production exactly (`EXP_SKEW_SECONDS = 0`, because jsonwebtoken's
  default clockTolerance is 0 and firebase-admin passes no options).
- `sub` must be a non-empty string <=128 chars; `user_id` must agree with `sub`.
- Errors are typed, constant-worded, and never include token contents or claims.

## 3. Critical finding — the unsigned SSO development fallback

`controllers/ssoController.js` contains a branch that decodes an ID token
**without verifying its signature**. Characterisation tests exercise the real
handler (`__tests__/sso-fallback-characterisation.test.js`).

Reachable only when **all** of these hold:
1. `getApps().length === 0` (SDK not initialised)
2. `process.env.NODE_ENV !== 'production'`
3. `SSO_DEV_FALLBACK === '1'`
4. `FIREBASE_PROJECT_ID || SSO_EXPECTED_AUD` is non-empty
5. the token has three segments and decodes to JSON
6. `claims.aud === SSO_EXPECTED_AUD`

When they do, the handler proceeds to user lookup/creation and issues a session
pair. Proven: an unsigned `alg: none` token with the project audience is accepted
with **201**, and a token with **no `exp` claim** is also accepted (the expiry
guard is `if (decodedToken.exp && ...)`, so an absent claim skips it).

The audience guard is not a secret: the Firebase project id ships inside every
client build. In such an environment the only credential an attacker needs is a
public string, so this is full authentication bypass, not a weaker check.

Current mitigation is that production sets `NODE_ENV=production`, which returns
503. The risk is any deployed environment that is not exactly `production`
(staging, preview, a misconfigured service) with the flag set.

### Why a replacement changes the calculus
The fallback is gated on `getApps().length === 0`. Removing firebase-admin makes
`require('firebase-admin/app')` at line 61 throw, which currently lands in the
catch and returns 401 — accidentally safe, but only because the require is
unguarded. Any well-meaning edit that makes the require optional (try/catch, or
"if the SDK is missing, use the fallback") converts that accident into a live
bypass in every non-production environment.

### Proposed remediation (not applied — production file untouched)
Delete the branch. Replace the whole block with a single readiness check:

```js
// No unverified path exists, in any environment.
if (!ssoVerifier) {
    logger.error('[SSO] verifier is not configured; refusing to authenticate');
    return res.status(503).json({ success: false, message: 'SSO unavailable.' });
}
decodedToken = await ssoVerifier.verify(idToken);
```

If a local development path is genuinely required, it must not live in this
handler: use a dedicated test fixture that signs with a local key, or point the
verifier at the Firebase emulator. Decoding must never be an authentication path.

### Route-level tests required with that change
1. Unsigned token (`alg: none`), correct aud, `SSO_DEV_FALLBACK=1`,
   `NODE_ENV=development` → **refused**, no user read or write, no session issued.
2. Same token with `NODE_ENV=production` → refused.
3. Unsigned token with no `exp` → refused.
4. Valid signature, wrong aud → refused; wrong iss → refused; expired → refused.
5. Valid token → 200/201 and a session pair.
6. Assert `prisma.user.findUnique/create` are never called on any refusal.

The existing characterisation tests are written so this fix is a one-line
inversion: "ACCEPTS an unsigned token" becomes "REFUSES an unsigned token".

## 4. `auth_time` compatibility

`auth_time` is required by this verifier and not checked by firebase-admin at all,
so it is strictly stricter. Firebase ID tokens always carry `auth_time` for the
supported flows: the controller accepts only `provider: 'google' | 'apple'` tokens
obtained by the client SDK (`signInWithPopup`/`signInWithCredential`), and those
tokens include `auth_time` as seconds since the original sign-in. Refresh-token
exchange preserves it.

Residual risk: a token minted outside Firebase Auth (for example, a hand-built
JWT from a test harness) would be refused. That is the intended behaviour and is
the reason this must be stated explicitly rather than assumed.

## 5. FCM compatibility (verified against production source)

Preserved: credential priority (primary var → secondary base64 var → local file),
raw JSON or base64 with URL-safe and unpadded tolerance, constant parse-error
messages that cannot echo a key, fail-safe boot (log + disable, never throw),
`FLUTTER_NOTIFICATION_CLICK` default with caller override, string-only `data`,
service-account OAuth assertion (`iss`/`scope`/`aud`/`iat`/`exp`, RS256),
project-scoped `messages:send` URL, `notification.title|body|image`, bearer auth,
no credential or token in any error, and no automatic retry.

Changed or unproven: delivery is one attempt (no SDK retry queue); a timeout or a
lost response after the request is dispatched is reported as
`FCM_SEND_OUTCOME_UNKNOWN` with `deliveryUnknown: true` and
`retryPolicy: 'reconcile-first'`, which the SDK does not surface; no topic or
multicast sends (unused today); `sendEach`/batch semantics absent (unused today).
Unproven without production callers: behaviour inside `utils/firebaseService.js`
itself (it still imports firebase-admin), and end-to-end delivery to a real
device, which this review deliberately does not exercise.

## 6. Residual risks

1. No revocation check. Production calls `verifyIdToken(idToken)` with one
   argument, so this is **parity, not a regression** — but it means a revoked
   user keeps access until token expiry (up to 1 hour).
2. No emulator bypass (deliberate). A cutover must never point at an emulator.
3. Duplicate JSON keys resolve to the last value; the signature covers the raw
   bytes, so only the issuer could construct such a token. Not exploitable.
4. `header.crit` is not rejected (jsonwebtoken ignores it too; parity).
5. The verifier is only as good as its wiring. If a caller resolves keys from a
   caller-supplied URL, or skips `verifyIdToken` for a "fast path", none of the
   above matters.

## Addendum 2026-11-04 — exposure assessment of the SSO fallback

Verified against production, not just the PR branch:

- `controllers/ssoController.js` is **byte-identical** on `main` `0edefa1d` and on
  `#384` `73109be` (empty `git diff`), so the weakness is live production code.
- `SSO_DEV_FALLBACK` appears **only** inside that controller. It is set in neither
  `.env.example` nor `render.yaml`, so no committed configuration enables it.
- `render.yaml` pins `NODE_ENV: production`, which short-circuits the branch to a
  503. Current production exposure is therefore **low and configuration-dependent**,
  not an open door today.
- The route is throttled: `src/routes/index.js` mounts `/api/auth` behind
  `authLimiter` (5 requests/minute per IP), so token spraying is bounded.
  Caveat: `authLimiter` is wrapped in `_failOpen`, so a Redis outage disables
  throttling for the whole process until restart. That is an availability trade
  and should be a conscious one.

The guard is also the wrong polarity: it tests `NODE_ENV === 'production'`, so an
unset `NODE_ENV` counts as safe-to-bypass. Characterisation test added proving a
token with **no `exp` claim** is accepted when `NODE_ENV` is unset and the flag is
on. Any host that forgets to set `NODE_ENV` is on the unsafe side by default.

Conclusion: the risk today is configuration drift, not an active exploit. It stops
being theoretical the moment `SSO_DEV_FALLBACK=1` reaches any non-production
deployment, and the fallback must be deleted rather than re-gated.
