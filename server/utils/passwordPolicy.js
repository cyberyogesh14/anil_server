/**
 * Single source of truth for the password policy, shared by registration,
 * password reset and password change so the three flows can never drift apart.
 * Passwords are validated here but never logged or echoed back to the client.
 */

const MIN_PASSWORD_LENGTH = 8;

const isPasswordAllowed = (password) =>
  typeof password === 'string' && password.length >= MIN_PASSWORD_LENGTH;

/** Returns a user-facing error message, or null when the password is fine. */
const validatePassword = (password) =>
  isPasswordAllowed(password)
    ? null
    : `Password must be at least ${MIN_PASSWORD_LENGTH} characters`;

module.exports = {
  MIN_PASSWORD_LENGTH,
  isPasswordAllowed,
  validatePassword,
};