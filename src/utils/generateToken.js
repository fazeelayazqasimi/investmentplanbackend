const jwt = require('jsonwebtoken');

/**
 * Generates a signed JWT containing the user's ID and role.
 * The token is used to authenticate subsequent requests via
 * the Authorization header (Bearer token).
 *
 * @param {string} userId - MongoDB ObjectId of the user
 * @param {string} role - User's role (USER or ADMIN)
 * @returns {string} signed JWT
 */
const generateToken = (userId, role) => {
  if (!process.env.JWT_SECRET) {
    throw new Error('JWT_SECRET is not defined in environment variables');
  }

  return jwt.sign(
    {
      id: userId,
      role: role,
    },
    process.env.JWT_SECRET,
    {
      expiresIn: process.env.JWT_EXPIRES_IN || '7d',
    }
  );
};

module.exports = generateToken;