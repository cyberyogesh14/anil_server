const jwt = require('jsonwebtoken');
const User = require('../models/User');

/**
 * The fields authentication needs, and the only ones `req.user` is ever read for.
 *
 * Every secret on the User schema (`password`, `otpHash`, `otpExpiresAt`,
 * `otpAttempts`, `lastOtpSentAt`, `resetPasswordToken`, `resetPasswordExpire`)
 * is already `select: false`, so it can never be loaded by this query even
 * without the allow-list. Naming the fields explicitly makes that guarantee
 * independent of the schema, keeps `addresses` (a whole subdocument array) out
 * of a query that only needs to know *who* is calling, and lets `.lean()` skip
 * hydration entirely.
 */
const AUTH_FIELDS =
  '_id name email phone role avatar isActive tokenVersion emailVerified marketingConsent';

const protect = async (req, res, next) => {
  let token;

  if (
    req.headers.authorization &&
    req.headers.authorization.startsWith('Bearer')
  ) {
    token = req.headers.authorization.split(' ')[1];
  }

  if (!token) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized, please login',
    });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);

    // Still a live read on every authenticated request, by design. `tokenVersion`
    // and `isActive` are what make the token revocable (audit finding F-03), so
    // this cannot be cached for even a few seconds: caching it would let a
    // suspended account or a logged-out session keep working for the length of
    // the TTL, which is the exact hole F-03 was raised to close. The win here is
    // `.lean()` - it avoids building a Mongoose document, its subdocuments and
    // its getters on every request - not skipping the round trip.
    const user = await User.findById(decoded.id)
      .select(AUTH_FIELDS)
      .lean();

    if (!user) {
      return res.status(401).json({
        success: false,
        message: 'User not found',
      });
    }

    if (!user.isActive) {
      return res.status(401).json({
        success: false,
        message: 'Account has been deactivated',
      });
    }

    // Audit finding F-03: the token's tokenVersion must still match the stored one.
    // A mismatch means the session was revoked after this token was issued - the
    // password was changed or reset, the user logged out, or their role changed.
    // Tokens minted before tokenVersion existed carry no value, which is read as 0.
    const tokenVersion =
      typeof decoded.tokenVersion === 'number' ? decoded.tokenVersion : 0;

    if (tokenVersion !== (user.tokenVersion || 0)) {
      return res.status(401).json({
        success: false,
        message: 'Session expired, please login again',
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(401).json({
      success: false,
      message: 'Not authorized, token invalid',
    });
  }
};

/**
 * Attaches `req.user` when a valid token is present, but never rejects the request.
 *
 * For endpoints that are public by design yet need to behave differently for staff
 * - `GET /api/products/:id` hides unpublished products from shoppers but lets an
 * editor preview one (audit finding F-05).
 *
 * This is deliberately NOT a weaker `protect`: every check `protect` performs is
 * repeated here, including the F-03 tokenVersion comparison, and a token that fails
 * any of them is simply treated as absent. An anonymous or invalid caller therefore
 * gets exactly the public behaviour, never a privileged one.
 */
const optionalAuth = async (req, res, next) => {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : null;

  if (!token) return next();

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const user = await User.findById(decoded.id)
      .select(AUTH_FIELDS)
      .lean();

    if (!user || !user.isActive) return next();

    const tokenVersion =
      typeof decoded.tokenVersion === 'number' ? decoded.tokenVersion : 0;
    if (tokenVersion !== (user.tokenVersion || 0)) return next();

    req.user = user;
  } catch {
    // An unusable token is not an error here; the request continues anonymously.
  }

  return next();
};

module.exports = protect;
module.exports.protect = protect;
module.exports.optionalAuth = optionalAuth;
module.exports.AUTH_FIELDS = AUTH_FIELDS;
