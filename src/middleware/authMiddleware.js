const jwt = require('jsonwebtoken');
const asyncHandler = require('express-async-handler');
const User = require('../models/User');

// ==========================================
// AUTHENTICATE - Verifies JWT and attaches req.user
// ==========================================
const authenticate = asyncHandler(async (req, res, next) => {
  let token;

  const authHeader = req.headers.authorization;

  if (authHeader && authHeader.startsWith('Bearer ')) {
    token = authHeader.split(' ')[1];
  }

  if (!token) {
    res.status(401);
    throw new Error('Not authorized, no token provided');
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (error) {
    if (error.name === 'TokenExpiredError') {
      res.status(401);
      throw new Error('Session expired, please log in again');
    }
    res.status(401);
    throw new Error('Not authorized, invalid token');
  }

  // Confirm the user still exists (e.g. not deleted after token was issued)
  const user = await User.findById(decoded.id);

  if (!user) {
    res.status(401);
    throw new Error('Not authorized, user no longer exists');
  }

  if (user.accountStatus !== 'ACTIVE') {
    res.status(403);
    throw new Error('Your account is not active');
  }

  // Attach minimal, trustworthy user context to the request
  req.user = {
    id: user._id.toString(),
    role: user.role,
  };

  next();
});

// ==========================================
// AUTHORIZE ADMIN - Blocks non-admin users
// ==========================================
const authorizeAdmin = (req, res, next) => {
  if (!req.user || req.user.role !== 'ADMIN') {
    res.status(403);
    throw new Error('Access denied: admin privileges required');
  }
  next();
};

module.exports = {
  authenticate,
  authorizeAdmin,
};