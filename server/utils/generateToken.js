const jwt = require('jsonwebtoken');

/**
 * Issues the API's access token.
 *
 * The payload carries `id` plus `tokenVersion`, a per-user counter that is stamped
 * at issue time and compared against the stored value on every authenticated request
 * (see `middleware/authMiddleware.js`). Incrementing it invalidates every token
 * issued before the change, which is how a password change, logout or role change
 * revokes sessions in an otherwise stateless scheme (audit finding F-03).
 *
 * Accepts either a user document or a bare id. A bare id cannot know the current
 * `tokenVersion`, so it falls back to 0 and the caller must issue the token from a
 * freshly loaded user — `issueToken` below does that safely.
 *
 * @param {import('mongoose').Document|import('mongoose').Types.ObjectId|string} user
 */
const generateToken = (user) => {
  const id = user && user._id ? user._id : user;
  const tokenVersion =
    user && typeof user.tokenVersion === 'number' ? user.tokenVersion : 0;

  return jwt.sign({ id, tokenVersion }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_EXPIRES_IN || '7d',
  });
};

const verifyToken = (token) => {
  return jwt.verify(token, process.env.JWT_SECRET);
};

module.exports = { generateToken, verifyToken };