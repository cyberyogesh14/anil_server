const requireRole = (...roles) => (req, res, next) => {
  if (req.user && roles.includes(req.user.role)) {
    return next();
  }
  return res.status(403).json({
    success: false,
    message: 'Access denied. You do not have permission.',
  });
};

module.exports = requireRole;