// middleware/adminMiddleware.js
const { isAdminUser } = require('./adminAccess');

exports.isAdmin = (req, res, next) => {
    if (isAdminUser(req.user)) {
        return next();
    }

    return res.status(403).json({ message: "Access denied. Admins only." });
};
