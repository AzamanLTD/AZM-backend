// middleware/adminMiddleware.js

exports.isAdmin = (req, res, next) => {
    if (req.user && req.user.role?.toUpperCase() === 'ADMIN') {
        next();
    } else {
        res.status(403).json({ message: "Access denied. Admins only." });
    }
};