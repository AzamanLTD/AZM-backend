// utils/catchAsync.js
const wrap = (fn) => (req, res, next) => {
    Promise.resolve(fn(req, res, next)).catch(next);
};
module.exports = { wrap };
