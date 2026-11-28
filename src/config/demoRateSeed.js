'use strict';

// Demo FX-rate seed (FX-balance workstream).
//
// The requested demo rate is:
//
//     1 USDC = GHS 12.03
//
// This is an EXPLICIT DEMO/TEST VALUE, never a production live rate:
//   • It is stored only via the demo seeder
//     (fxRateSnapshotService.seedDemoRateSnapshot) which writes an
//     FxSavedRate row with isDemoSeed = true and source 'DEMO_SEED'.
//   • It is DISPLAY-eligible only when demoModeRateSeedEnabled() is true —
//     NODE_ENV === 'test' (CI's disposable battery) or an EXPLICIT
//     opt-in flag (DEMO_RATE_SEED = '1'|'true'). Production deployments
//     (NODE_ENV === 'production' without the flag) can never read it as a
//     display fallback, and no environment ever reads it as a live
//     transaction rate.
//   • A demo seed NEVER overwrites a genuine saved observation and never
//     authorizes any transaction: the 271C transaction gate is a separate
//     authority that only a FRESH external observation can satisfy.
//   • It is never attributed to Binance or any real provider: 'DEMO_SEED'
//     is the honest provenance surfaced to the UI.

const DEMO_RATE_GHS_PER_USDC = '12.03';
const DEMO_RATE_SOURCE = 'DEMO_SEED';

function demoModeRateSeedEnabled(env = process.env) {
    if (env.NODE_ENV === 'test') return true;
    const flag = String(env.DEMO_RATE_SEED ?? '').trim().toLowerCase();
    return flag === '1' || flag === 'true' || flag === 'on';
}

module.exports = {
    DEMO_RATE_GHS_PER_USDC,
    DEMO_RATE_SOURCE,
    demoModeRateSeedEnabled,
};
