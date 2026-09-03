const { AsyncLocalStorage } = require('async_hooks');

const requestContext = new AsyncLocalStorage();

function withRequestContext(req, next) {
    return requestContext.run(req, next);
}

function getRequestContext() {
    return requestContext.getStore() || null;
}

module.exports = { withRequestContext, getRequestContext };
