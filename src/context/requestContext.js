'use strict';

const { AsyncLocalStorage } = require('node:async_hooks');

// Carries authenticated request context through the asynchronous service layer
// without threading Express req/res objects through every method signature.
const storage = new AsyncLocalStorage();

function run(context, callback) {
    return storage.run(context, callback);
}

function enter(context) {
    storage.enterWith(context);
}

function get() {
    return storage.getStore() || null;
}

module.exports = { run, enter, get };
