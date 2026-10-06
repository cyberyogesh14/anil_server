/**
 * Migration: mark existing accounts as email-verified.
 *
 * Accounts created before email verification existed have no emailVerified field.
 * They were able to login before, so treat them as verified rather than locking
 * them out. Existing users are never auto-opted in to marketing.
 *
 * Run: node scripts/migrateEmailVerified.js
 */
require('dotenv').config();
const connectDB = require('../config/db');
const User = require('../models/User');

(async () => {
  try {
    await connectDB();

    const result = await User.updateMany(
      { emailVerified: { $exists: false } },
      {
        $set: {
          emailVerified: true,
          emailVerifiedAt: new Date(),
        },
      }
    );

    console.log(
      `Migrated ${result.modifiedCount} existing user(s) to emailVerified = true`
    );
    process.exit(0);
  } catch (error) {
    console.error('Migration failed:', error.message);
    process.exit(1);
  }
})();