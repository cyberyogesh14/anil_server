const { escapeHtml, styles, layout } = require('./shared');

const marketingEmail = ({ customerName, subject, bodyHtml, unsubscribeUrl }) => {
  const greeting = customerName
    ? `<p style="${styles.p}">Hi ${escapeHtml(customerName)},</p>`
    : '';

  const body = `
    ${greeting}
    ${bodyHtml || '<p style="' + styles.p + '">' + escapeHtml(subject) + '</p>'}
    <hr style="${styles.hr}" />
    <p style="${styles.p}">
      You are receiving this because you opted in to receive promotional emails from AnilKabadi.
    </p>
  `;

  return layout({
    title: subject,
    badge: 'AnilKabadi',
    body,
    showFooter: true,
    unsubscribeUrl,
  });
};

module.exports = marketingEmail;