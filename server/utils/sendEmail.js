const { getTransporter } = require('../config/mail');

const sendEmail = async ({ to, subject, html }) => {
  const transporter = getTransporter();
  if (!transporter) {
    console.warn(`Email not sent (transporter not configured). Subject: ${subject}`);
    return false;
  }

  try {
    const fromName = process.env.EMAIL_FROM_NAME || 'AnilKabadi';
    const fromAddress = process.env.EMAIL_FROM || process.env.EMAIL_USER;

    await transporter.sendMail({
      from: `"${fromName}" <${fromAddress}>`,
      to,
      subject,
      html,
    });
    console.log(`Email sent to ${to}: ${subject}`);
    return true;
  } catch (error) {
    console.error(`Email send error: ${error.message}`);
    return false;
  }
};

module.exports = sendEmail;
