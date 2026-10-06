const escapeHtml = (value) =>
  String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

const CLIENT_URL = process.env.CLIENT_URL || 'http://localhost:5173';

const BRAND_BLUE = '#1d4ed8';
const DARK = '#0f172a';
const MUTED = '#64748b';

const styles = {
  body: 'margin:0;padding:0;background-color:#f1f5f9;font-family:Arial,Helvetica,sans-serif;',
  container:
    'max-width:600px;margin:0 auto;background-color:#ffffff;border-radius:8px;overflow:hidden;border:1px solid #e2e8f0;',
  header: `background-color:${BRAND_BLUE};padding:24px 32px;color:#ffffff;`,
  logoRow: 'display:flex;align-items:center;gap:10px;',
  logoIcon:
    'display:inline-block;background-color:#ffffff;color:' +
    BRAND_BLUE +
    ';font-weight:bold;font-size:18px;padding:6px 10px;border-radius:6px;',
  logoText: 'font-size:22px;font-weight:bold;color:#ffffff;margin:0;',
  content: 'padding:32px;color:' + DARK + ';font-size:15px;line-height:1.6;',
  h1: 'margin:0 0 16px;font-size:22px;color:' + DARK + ';',
  p: 'margin:0 0 16px;color:#334155;',
  button:
    'display:inline-block;background-color:' +
    BRAND_BLUE +
    ';color:#ffffff !important;text-decoration:none;padding:12px 24px;border-radius:6px;font-weight:bold;font-size:15px;',
  footer: 'background-color:#f8fafc;padding:20px 32px;border-top:1px solid #e2e8f0;',
  footerText: `margin:0 0 8px;font-size:13px;color:${MUTED};text-align:center;`,
  unsubscribe: 'font-size:13px;color:' + MUTED + ';text-align:center;',
  unsubscribeLink: 'color:' + BRAND_BLUE + ';text-decoration:underline;',
  badge:
    'display:inline-block;background-color:#dbeafe;color:' +
    BRAND_BLUE +
    ';font-size:12px;font-weight:bold;padding:4px 10px;border-radius:9999px;text-transform:uppercase;letter-spacing:0.5px;',
  table: 'width:100%;border-collapse:collapse;margin:16px 0;',
  th: 'background-color:#f1f5f9;color:#334155;font-size:13px;padding:10px;text-align:left;border-bottom:1px solid #e2e8f0;',
  td: 'font-size:14px;color:#0f172a;padding:10px;border-bottom:1px solid #f1f5f9;',
  right: 'text-align:right;',
  center: 'text-align:center;',
  infoBox:
    'background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:16px;margin:16px 0;',
  hr: 'border:0;border-top:1px solid #e2e8f0;margin:20px 0;',
};

function layout({ title, badge, body, showFooter = true, unsubscribeUrl = '' }) {
  const year = new Date().getFullYear();

  const unsubscribeBlock =
    showFooter && unsubscribeUrl
      ? `<p class="unsubscribe">Don't want promotional emails?<br>
           <a href="${escapeHtml(unsubscribeUrl)}" class="unsubscribe-link">Unsubscribe</a>
         </p>`
      : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)}</title>
</head>
<body style="${styles.body}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${styles.body}">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${styles.container}">
          <tr>
            <td style="${styles.header}">
              <div style="${styles.logoRow}">
                <span style="${styles.logoIcon}">AK</span>
                <h1 style="${styles.logoText}">AnilKabadi</h1>
              </div>
              <p style="margin:8px 0 0;font-size:13px;color:#dbeafe;">
                Old &amp; New Car Parts &middot; Tata BS6 Parts at Low Prices
              </p>
            </td>
          </tr>
          <tr>
            <td style="${styles.content}">
              ${badge ? `<p style="margin:0 0 12px;"><span style="${styles.badge}">${escapeHtml(badge)}</span></p>` : ''}
              ${body}
            </td>
          </tr>
          <tr>
            <td style="${styles.footer}">
              <p style="${styles.footerText}">
                AnilKabadi &middot; Old &amp; New Car Parts &middot; Tata BS6 Parts at Low Prices
              </p>
              <p style="${styles.footerText}">&copy; ${year} AnilKabadi. All rights reserved.</p>
              ${unsubscribeBlock}
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

module.exports = { escapeHtml, styles, layout, CLIENT_URL };