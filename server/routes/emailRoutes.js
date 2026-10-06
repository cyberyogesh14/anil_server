const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const { emailLimiter } = require('../middleware/rateLimitMiddleware');

const EMAIL_TOKEN_SECRET =
  process.env.EMAIL_TOKEN_SECRET || process.env.JWT_SECRET;

const page = ({ title, message, tone = 'green' }) => `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${title}</title>
  <style>
    body { margin:0; padding:0; background:#f1f5f9; font-family:Arial,Helvetica,sans-serif; color:#0f172a; }
    .card { max-width:480px; margin:60px auto; background:#ffffff; border-radius:10px; padding:32px;
            box-shadow:0 4px 16px rgba(15,23,42,0.08); border:1px solid #e2e8f0; text-align:center; }
    .logo { display:inline-block; background:#1d4ed8; color:#fff; font-weight:bold; font-size:18px;
            padding:8px 12px; border-radius:6px; margin-bottom:16px; }
    .title { font-size:22px; margin:0 0 12px; }
    .msg { font-size:15px; line-height:1.6; color:#334155; margin:0 0 20px; }
    .icon { font-size:44px; margin-bottom:12px; }
    a { color:#1d4ed8; }
  </style>
</head>
<body>
  <div class="card">
    <span class="logo">AK</span>
    <div class="icon">${tone === 'green' ? '&#10003;' : '&#9888;'}</div>
    <h1 class="title">${title}</h1>
    <p class="msg">${message}</p>
    <a href="${process.env.CLIENT_URL || 'http://localhost:5173'}">Back to AnilKabadi</a>
  </div>
</body>
</html>`;

router.get('/unsubscribe/:token', emailLimiter, async (req, res, next) => {
  try {
    const { token } = req.params;

    let payload;
    try {
      payload = jwt.verify(token, EMAIL_TOKEN_SECRET);
    } catch (error) {
      return res
        .status(400)
        .type('html')
        .send(
          page({
            title: 'Invalid Unsubscribe Link',
            message:
              'This link is invalid or has expired. Please use the unsubscribe link from a recent email.',
            tone: 'red',
          })
        );
    }

    if (!payload.sub || payload.purpose !== 'email_unsubscribe') {
      return res
        .status(400)
        .type('html')
        .send(
          page({
            title: 'Invalid Unsubscribe Link',
            message: 'This link is not valid for unsubscribing.',
            tone: 'red',
          })
        );
    }

    const user = await User.findById(payload.sub);
    if (!user) {
      return res
        .status(404)
        .type('html')
        .send(
          page({
            title: 'Account Not Found',
            message: 'We could not find the account associated with this link.',
            tone: 'red',
          })
        );
    }

    const updated = await User.findByIdAndUpdate(
      payload.sub,
      {
        marketingConsent: false,
        marketingConsentAt: null,
      },
      { new: true }
    );

    if (!updated) {
      return res
        .status(404)
        .type('html')
        .send(
          page({
            title: 'Account Not Found',
            message: 'We could not find the account associated with this link.',
            tone: 'red',
          })
        );
    }

    res.type('html').send(
      page({
        title: 'You are Unsubscribed',
        message:
          'You will no longer receive promotional emails from AnilKabadi. You can re-subscribe anytime from your profile. Your order-related emails are not affected.',
      })
    );
  } catch (error) {
    next(error);
  }
});

module.exports = router;