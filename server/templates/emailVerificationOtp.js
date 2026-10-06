const { escapeHtml, styles, layout } = require('./shared');

const emailVerificationOtp = ({ name, otp, expiresInMinutes = 10 }) => {
  const body = `
    <h1 style="${styles.h1}">Verify Your Email</h1>
    <p style="${styles.p}">Hello ${escapeHtml(name)},</p>
    <p style="${styles.p}">
      Use the verification code below to activate your AnilKabadi account.
    </p>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:24px 0;">
      <tr>
        <td align="center" style="background-color:#f1f5f9;border:1px solid #e2e8f0;border-radius:10px;padding:20px;">
          <span style="font-size:36px;font-weight:bold;letter-spacing:10px;color:#0f172a;">${escapeHtml(
            otp
          )}</span>
        </td>
      </tr>
    </table>
    <p style="${styles.p}">
      This code expires in <strong>${expiresInMinutes} minutes</strong>.
    </p>
    <p style="${styles.p}">
      If you didn't create an AnilKabadi account, you can ignore this email.
    </p>
    <p style="${styles.p}">Thanks,<br />The AnilKabadi Team</p>
    <hr style="${styles.hr}" />
    <p style="margin:0;font-size:12px;color:#94a3b8;text-align:center;">
      Never share this code with anyone. AnilKabadi will never ask for it.
    </p>
  `;

  return layout({
    title: 'Verify Your Email - AnilKabadi',
    badge: 'Verify Your Email',
    body,
    showFooter: false,
  });
};

module.exports = emailVerificationOtp;