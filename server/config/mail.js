const nodemailer = require('nodemailer');

let transporter = null;

const configureMail = () => {
  const user = process.env.EMAIL_USER;
  const pass = process.env.EMAIL_PASS;

  if (!user || !pass) {
    console.warn('Email not configured - emails will not be sent');
    return false;
  }

  const host = process.env.EMAIL_HOST;
  const port = Number(process.env.EMAIL_PORT) || 587;

  if (host) {
    transporter = nodemailer.createTransport({
      host,
      port,
      secure: port === 465,
      auth: {
        user,
        pass,
      },
    });
  } else {
    transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user,
        pass,
      },
    });
  }

  console.log('Email transporter configured');
  return true;
};

const getTransporter = () => transporter;

module.exports = { configureMail, getTransporter };
