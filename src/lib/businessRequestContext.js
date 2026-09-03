const { AsyncLocalStorage } = require('node:async_hooks');

const storage = new AsyncLocalStorage();

function runWithBusinessRequestContext(context, callback) {
    return storage.run(context, callback);
}

function getBusinessRequestContext() {
    return storage.getStore() || null;
}

module.exports = { runWithBusinessRequestContext, getBusinessRequestContext };
