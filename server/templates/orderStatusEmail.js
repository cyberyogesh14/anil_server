const { escapeHtml, styles, layout, CLIENT_URL } = require('./shared');

const orderStatusEmail = ({ customerName, orderNumber, status, message }) => {
  const body = `
    <h1 style="${styles.h1}">Order Update</h1>
    <p style="${styles.p}">Hi ${escapeHtml(customerName)},</p>
    <p style="${styles.p}">${escapeHtml(message)}.</p>
    <div style="${styles.infoBox}">
      <p style="margin:0 0 4px;font-size:14px;"><strong>Order Number:</strong> ${escapeHtml(orderNumber)}</p>
      <p style="margin:0;"><strong>Status:</strong> ${escapeHtml(status.replace(/_/g, ' ').toUpperCase())}</p>
    </div>
    <p style="margin:24px 0;">
      <a href="${escapeHtml(CLIENT_URL)}/orders" style="${styles.button}">View Order</a>
    </p>
    <p style="${styles.p}">Thanks,<br />The AnilKabadi Team</p>
  `;

  return layout({
    title: `Order ${status.replace(/_/g, ' ')} - ${orderNumber}`,
    badge: `Order ${status.replace(/_/g, ' ')}`,
    body,
    showFooter: false,
  });
};

module.exports = orderStatusEmail;