const { escapeHtml, styles, layout, CLIENT_URL } = require('./shared');

const welcomeEmail = ({ name, marketingConsent = false }) => {
  const body = `
    <h1 style="${styles.h1}">Welcome to AnilKabadi, ${escapeHtml(name)}!</h1>
    <p style="${styles.p}">
      Thanks for creating your account. You can now shop for
      <strong>Old &amp; New Car Parts</strong> at the best prices, including
      <strong>Tata BS6 Parts at Low Prices</strong>.
    </p>
    <div style="${styles.infoBox}">
      <p style="margin:0 0 6px;font-size:14px;color:#334155;">
        <strong>Old &amp; New Car Parts</strong>
      </p>
      <p style="margin:0 0 6px;font-size:14px;color:#334155;">
        <strong>Tata BS6 Parts at Low Prices</strong>
      </p>
      <p style="margin:0;font-size:14px;color:#334155;">
        Wide range of parts for Tata vehicles - new, used and refurbished.
      </p>
    </div>
    <p style="${styles.p}">
      ${marketingConsent
        ? 'You have also signed up for promotional offers, discounts and new product updates. You can opt out anytime from your profile.'
        : 'Want promotional offers, discounts and new product updates? You can opt in anytime from your profile.'}
    </p>
    <p style="margin:24px 0;">
      <a href="${escapeHtml(CLIENT_URL)}/login" style="${styles.button}">Login &amp; Shop</a>
    </p>
    <p style="${styles.p}">Happy shopping,<br />The AnilKabadi Team</p>
  `;

  return layout({
    title: 'Welcome to AnilKabadi!',
    badge: 'Welcome',
    body,
    showFooter: false,
  });
};

module.exports = welcomeEmail;