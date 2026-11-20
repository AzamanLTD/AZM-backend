'use strict';

// =============================================================================
// §WP-I — THE TRUSTED COLLECTION WALLET
//
// The wallet in a wallet-scoped observation identity must be the account WE
// configured, never a value taken from a caller's body or from the provider
// payload's `accountnumber`. A provider payload can say anything; if its account
// were trusted, an attacker could steer an observation into a different identity
// and claim the same payment twice.
//
// So this module reads the configured collection account and nothing else. When
// it is unset or unusable the answer is null, and every caller must treat that as
// "unknown wallet" and refuse — never as "use the default".
// =============================================================================

const { normalizeWalletAccount } = require('./providerObservationIdentity');

function trustedCollectionWallet(env = process.env) {
    return normalizeWalletAccount(env.MOOLRE_ACCOUNT_NUMBER);
}

module.exports = { trustedCollectionWallet };
