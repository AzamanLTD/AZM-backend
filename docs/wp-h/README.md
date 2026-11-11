# WP-H — authority live-decision wiring (PREPARED, NOT APPLIED)

`authority-live-decision.patch` wires `FiatLiquidityActivationService.readMode()`
and `readModeAndPool()` to `authorityActivationEnforcement.readEnforcedAuthority()`
so the live regime is decided by the protected activation record plus a verified
role-enforcement inspection, never by `GlobalSettings.fiatLiquidityAuthorityEnabled`
or `FiatLiquidityState.authorityActivatedAt` (both writable by the runtime
credential). It also adds two proofs to `p5e-enforced-authority-activation.pg.test.js`
(flag+latch cannot activate; clearing both after activation cannot deactivate).

**Why it is not applied yet.** Applying it turns 63 tests red across
`p5d-fiat-liquidity-authority`, `p5d-latched-regime-contract`,
`p5d-legacy-under-authority-regime` and `native-ghs-withdrawal` (137 total,
63 failing). Those suites simulate the GHS regime by setting the legacy flag or
latch. That is exactly the shortcut WP-H forbids, and it cannot work in a
single-role test database: with one superuser/owner principal the enforcement
inspection correctly reports "not established", so the protected regime stays
unavailable — which is the production behaviour we want.

**Remaining work (the real blocker).** Each of those four suites must provision
real separated roles the way `p5e-enforced-authority-activation.pg.test.js`
does (migrator / NOLOGIN owner / restricted runtime / operator), install the
activation table through the privileged provisioning path, and activate by
inserting the record as the operator — then the money paths read GHS for the
right reason. Until that is done, WP-H ships nothing: an installer, a table and
an unused enforcement module do not constitute enforcement.

Patch applies with `git apply docs/wp-h/authority-live-decision.patch` on
`integration/399-hardening` at or after 14bb940.
