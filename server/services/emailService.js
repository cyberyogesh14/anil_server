const jwt = require('jsonwebtoken');
const sendEmail = require('../utils/sendEmail');
const welcomeTemplate = require('../templates/welcomeEmail');
const emailVerificationOtpTemplate = require('../templates/emailVerificationOtp');
const orderConfirmationTemplate = require('../templates/orderConfirmationEmail');
const orderStatusTemplate = require('../templates/orderStatusEmail');
const marketingTemplate = require('../templates/marketingEmail');

const EMAIL_TOKEN_SECRET =
  process.env.EMAIL_TOKEN_SECRET || process.env.JWT_SECRET;
const API_BASE_URL = process.env.API_URL || 'http://localhost:5000/api';

const createUnsubscribeToken = (userId) =>
  jwt.sign({ sub: String(userId), purpose: 'email_unsubscribe' }, EMAIL_TOKEN_SECRET, {
    expiresIn: '365d',
  });

const buildUnsubscribeUrl = (userId) =>
  `${API_BASE_URL}/email/unsubscribe/${createUnsubscribeToken(userId)}`;

const send = async ({ to, subject, html }) => {
  try {
    return await sendEmail({ to, subject, html });
  } catch (error) {
    console.error(`Email send error (${subject}): ${error.message}`);
    return false;
  }
};

const sendWelcomeEmail = ({ to, name, marketingConsent = false }) => {
  if (!to) return false;
  return send({
    to,
    subject: 'Welcome to AnilKabadi!',
    html: welcomeTemplate({ name, marketingConsent }),
  });
};

const sendVerificationOtpEmail = ({ to, name, otp }) => {
  if (!to) return false;
  return send({
    to,
    subject: 'Verify Your Email - AnilKabadi',
    html: emailVerificationOtpTemplate({ name, otp }),
  });
};

const sendOrderConfirmationEmail = ({
  to,
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
  if (!to) return false;
  return send({
    to,
    subject: `Order Confirmed - ${orderNumber}`,
    html: orderConfirmationTemplate({
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
    }),
  });
};

const sendOrderStatusEmail = ({
  to,
  customerName,
  orderNumber,
  status,
  message,
}) => {
  if (!to) return false;
  return send({
    to,
    subject: `Order ${status.replace(/_/g, ' ')} - ${orderNumber}`,
    html: orderStatusTemplate({ customerName, orderNumber, status, message }),
  });
};

const sendMarketingEmail = ({
  to,
  customerName,
  subject,
  bodyHtml,
  userId,
}) => {
  if (!to) return false;
  return send({
    to,
    subject,
    html: marketingTemplate({
      customerName,
      subject,
      bodyHtml,
      unsubscribeUrl: buildUnsubscribeUrl(userId),
    }),
  });
};

const sendTestEmail = ({ to, customerName, subject, bodyHtml }) => {
  if (!to) return false;
  return send({
    to,
    subject: `[TEST] ${subject}`,
    html: marketingTemplate({
      customerName,
      subject: `[TEST] ${subject}`,
      bodyHtml,
      unsubscribeUrl: '',
    }),
  });
};

module.exports = {
  createUnsubscribeToken,
  buildUnsubscribeUrl,
  sendWelcomeEmail,
  sendVerificationOtpEmail,
  sendOrderConfirmationEmail,
  sendOrderStatusEmail,
  sendMarketingEmail,
  sendTestEmail,
};