const { escapeHtml, styles, layout, CLIENT_URL } = require('./shared');

const formatINR = (amount) =>
  `₹${Number(amount || 0).toLocaleString('en-IN', {
    maximumFractionDigits: 2,
  })}`;

const orderConfirmationEmail = ({
  customerName,
  orderNumber,
  orderDate,
  items,
  subtotal,
  discount,
  shippingFee,
  gstAmount,
  totalAmount,
  shippingAddress,
  paymentMethod,
  paymentStatus,
  razorpayPaymentId,
  orderStatus,
}) => {
  const rows = (items || [])
    .map(
      (item) => `
    <tr>
      <td style="${styles.td}">
        ${escapeHtml(item.name)}
        ${item.sku ? `<br /><span style="color:#94a3b8;font-size:12px;">SKU: ${escapeHtml(item.sku)}</span>` : ''}
      </td>
      <td style="${styles.td};${styles.center}">${item.quantity}</td>
      <td style="${styles.td};${styles.right}">${formatINR(item.price * item.quantity)}</td>
    </tr>
  `
    )
    .join('');

  const addr = [
    shippingAddress.fullName,
    shippingAddress.phone,
    shippingAddress.addressLine1,
    shippingAddress.addressLine2,
    `${shippingAddress.city}, ${shippingAddress.state} - ${shippingAddress.pincode}`,
    shippingAddress.country,
  ]
    .filter(Boolean)
    .map((line) => escapeHtml(line))
    .join('<br />');

  const isOnline = paymentMethod === 'online';

  const paymentMethodLabel = isOnline
    ? 'Online (Razorpay)'
    : 'Cash on Delivery';

  const paymentStatusLabel = isOnline
    ? paymentStatus === 'paid'
      ? 'Paid'
      : paymentStatus === 'failed'
        ? 'Failed'
        : paymentStatus === 'refunded'
          ? 'Refunded'
          : 'Pending'
    : 'Pay on delivery';

  // Only shown once a real Razorpay payment reference exists, so a failed or
  // abandoned attempt never displays a bogus reference.
  const paymentReferenceRow =
    isOnline && paymentStatus === 'paid' && razorpayPaymentId
      ? `<p style="margin:0 0 4px;font-size:14px;"><strong>Razorpay Payment ID:</strong> ${escapeHtml(razorpayPaymentId)}</p>`
      : '';

  const body = `
    <h1 style="${styles.h1}">Thank You, ${escapeHtml(customerName)}!</h1>
    <p style="${styles.p}">${
      isOnline && paymentStatus === 'paid'
        ? 'We have received your payment and your order is confirmed.'
        : 'Your order has been placed successfully.'
    }</p>
    <div style="${styles.infoBox}">
      <p style="margin:0 0 4px;font-size:14px;"><strong>Order Number:</strong> ${escapeHtml(orderNumber)}</p>
      <p style="margin:0 0 4px;font-size:14px;"><strong>Order Date:</strong> ${escapeHtml(orderDate)}</p>
      <p style="margin:0 0 4px;font-size:14px;"><strong>Payment Method:</strong> ${paymentMethodLabel}</p>
      <p style="margin:0 0 4px;font-size:14px;"><strong>Payment Status:</strong> ${paymentStatusLabel}</p>
      ${paymentReferenceRow}
      <p style="margin:0;font-size:14px;"><strong>Order Status:</strong> ${escapeHtml(String(orderStatus || '').replace(/_/g, ' ').toUpperCase())}</p>
    </div>


    <table role="presentation" style="${styles.table}">
      <tr>
        <th style="${styles.th}">Product</th>
        <th style="${styles.th};${styles.center}">Qty</th>
        <th style="${styles.th};${styles.right}">Price</th>
      </tr>
      ${rows || '<tr><td style="' + styles.td + '">-</td><td>-</td><td>-</td></tr>'}
    </table>

    <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
      <tr>
        <td style="text-align:right;font-size:14px;color:#334155;padding:4px 0;">Subtotal</td>
        <td style="text-align:right;font-size:14px;color:#0f172a;font-weight:bold;padding:4px 0;width:120px;">${formatINR(subtotal)}</td>
      </tr>
      <tr>
        <td style="text-align:right;font-size:14px;color:#334155;padding:4px 0;">Discount</td>
        <td style="text-align:right;font-size:14px;color:#16a34a;font-weight:bold;padding:4px 0;">- ${formatINR(discount)}</td>
      </tr>
      <tr>
        <td style="text-align:right;font-size:14px;color:#334155;padding:4px 0;">Shipping</td>
        <td style="text-align:right;font-size:14px;color:#0f172a;font-weight:bold;padding:4px 0;">${Number(shippingFee) === 0 ? 'FREE' : formatINR(shippingFee)}</td>
      </tr>
      ${Number(gstAmount) > 0 ? `
      <tr>
        <td style="text-align:right;font-size:14px;color:#334155;padding:4px 0;">GST</td>
        <td style="text-align:right;font-size:14px;color:#0f172a;font-weight:bold;padding:4px 0;">${formatINR(gstAmount)}</td>
      </tr>
      ` : ''}
      <tr>
        <td style="text-align:right;font-size:16px;color:#0f172a;font-weight:bold;padding:8px 0;border-top:2px solid #e2e8f0;">Total</td>
        <td style="text-align:right;font-size:16px;color:#1d4ed8;font-weight:bold;padding:8px 0;border-top:2px solid #e2e8f0;">${formatINR(totalAmount)}</td>
      </tr>
    </table>

    <h2 style="font-size:16px;margin:24px 0 8px;color:#0f172a;">Shipping Address</h2>
    <p style="margin:0 0 24px;font-size:14px;color:#334155;line-height:1.6;">${addr}</p>

    <p style="margin:24px 0;">
      <a href="${escapeHtml(CLIENT_URL)}/orders" style="${styles.button}">View Order</a>
    </p>
    <p style="${styles.p}">Thanks for shopping with us!<br />The AnilKabadi Team</p>
  `;

  return layout({
    title: `Order Confirmed - ${orderNumber}`,
    badge: 'Order Confirmed',
    body,
    showFooter: false,
  });
};

module.exports = orderConfirmationEmail;