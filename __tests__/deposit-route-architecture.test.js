// __tests__/deposit-route-architecture.test.js
//
// Architectural regression protection for the fiat deposit contract (issue
// #271, PR 271A). Not a string-absence test: it inspects the REAL Express
// router stack of routes/depositRoutes.js and asserts that every mounted fiat
// deposit route resolves to a handler owned by the quote-backed controllers
// (or, for crypto deposits, the Tatum handler). Any future attempt to remount
// a legacy re-pricing handler — or to remove the quote-backed wiring — fails
// here regardless of how it is named.
//
// No database required: middleware factories are require-safe and handlers
// are compared by reference, never invoked.

const express = require('express');

const depositRouter = require('../routes/depositRoutes');
const depositController = require('../controllers/depositController');
const quoteFiatDepositController = require('../controllers/quoteFiatDepositController');
const moolreQuoteDepositController = require('../controllers/moolreQuoteDepositController');

// Walk the actual Express router and build a { 'METHOD /path': finalHandler }
// map from the live route stack.
function mountedHandlers(router) {
    const handlers = {};
    for (const layer of router.stack) {
        if (!layer.route) continue;
        const method = layer.route.stack[0].method.toUpperCase();
        // The terminal handler of a route's middleware chain is the controller.
        handlers[`${method} ${layer.route.path}`] = layer.route.stack[layer.route.stack.length - 1].handle;
    }
    return handlers;
}

describe('Deposit route architecture — fiat settlement is quote-backed only', () => {
    const handlers = mountedHandlers(depositRouter);

    test('the deposit router mounts the expected number of routes', () => {
        // 7 POST routes: fiat initiate, fiat webhook, tatum, moolre initiate,
        // moolre otp, moolre webhook, validate-name.
        expect(Object.keys(handlers).length).toBe(7);
    });

    test('every mounted fiat initiation/settlement route resolves to a quote-backed controller handler', () => {
        expect(handlers['POST /fiat/initiate']).toBe(quoteFiatDepositController.initiate);
        expect(handlers['POST /fiat/webhook']).toBe(quoteFiatDepositController.webhook);
        expect(handlers['POST /fiat/initiate/moolre']).toBe(moolreQuoteDepositController.initiate);
        expect(handlers['POST /fiat/initiate/moolre/otp']).toBe(quoteFiatDepositController.confirmMoolreOtp);
        expect(handlers['POST /fiat/webhook/moolre']).toBe(moolreQuoteDepositController.webhook);
    });

    test('crypto deposits and name validation remain on the deposit controller', () => {
        expect(handlers['POST /webhook/tatum']).toBe(depositController.tatumCryptoWebhook);
        expect(handlers['POST /validate-name']).toBe(depositController.validateMomoName);
    });

    test('the deposit controller no longer exports legacy fiat settlement handlers', () => {
        // The legacy re-pricing implementations were removed (issue #271).
        // If any of these reappear, a deliberate decision to re-introduce a
        // second financial contract is required — not a silent restore.
        expect(Object.keys(depositController).sort()).toEqual(['tatumCryptoWebhook', 'validateMomoName']);
    });

    test('the quote controllers export only their mounted quote-backed handlers', () => {
        expect(Object.keys(quoteFiatDepositController).sort()).toEqual(['confirmMoolreOtp', 'initiate', 'webhook']);
        expect(Object.keys(moolreQuoteDepositController).sort()).toEqual(['initiate', 'webhook']);
    });

    test('every quote-backed settlement handler is wired to consume a persisted TransactionQuote', () => {
        // Static contract check: the mounted settlement paths must consume the
        // exactly-once, fixed-price quote claim — either directly or through
        // the shared once-settlement core (r15 R15-B extracted the Moolre
        // webhook's settlement transaction into src/services/
        // moolreDepositSettlement.js, which itself calls consumeTransactionQuote).
        const moolreDepositSettlement = require('../src/services/moolreDepositSettlement');
        expect(moolreDepositSettlement.settleMoolreDeposit.toString()).toMatch(/consumeTransactionQuote/);
        expect(moolreQuoteDepositController.webhook.toString()).toMatch(/settleMoolreDeposit/);
        expect(quoteFiatDepositController.webhook.toString()).toMatch(/consumeTransactionQuote/);
    });
});
