const { AsyncLocalStorage } = require('async_hooks');

const requestContext = new AsyncLocalStorage();

function runWithRequestContext(context, callback) {
    return requestContext.run(context, callback);
}

function getRequestContext() {
    return requestContext.getStore() || null;
}

module.exports = { getRequestContext, runWithRequestContext };
