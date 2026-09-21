const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT) || 587,
  secure: Number(process.env.SMTP_PORT) === 465,
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
});

const FROM = process.env.SMTP_FROM || `"FinRise Global" <${process.env.SMTP_USER}>`;

const verificationTemplate = (code) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,sans-serif;">
  <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px 24px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:22px;">FinRise Global</h1>
    </div>
    <div style="padding:32px 24px;text-align:center;">
      <h2 style="color:#1a1a2e;margin:0 0 12px;">Email Verification</h2>
      <p style="color:#666;font-size:14px;margin:0 0 24px;">Use the code below to verify your email address. This code expires in <strong>1 minute</strong>.</p>
      <div style="background:#f4f4f7;border-radius:8px;padding:20px;margin:0 0 24px;">
        <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#6366f1;">${code}</span>
      </div>
      <p style="color:#999;font-size:12px;margin:0;">If you did not create an account, please ignore this email.</p>
    </div>
  </div>
</body>
</html>
`;

const passwordResetTemplate = (code) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,sans-serif;">
  <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px 24px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:22px;">FinRise Global</h1>
    </div>
    <div style="padding:32px 24px;text-align:center;">
      <h2 style="color:#1a1a2e;margin:0 0 12px;">Password Reset</h2>
      <p style="color:#666;font-size:14px;margin:0 0 24px;">Use the code below to reset your password. This code expires in <strong>1 minute</strong>.</p>
      <div style="background:#f4f4f7;border-radius:8px;padding:20px;margin:0 0 24px;">
        <span style="font-size:36px;font-weight:bold;letter-spacing:8px;color:#6366f1;">${code}</span>
      </div>
      <p style="color:#999;font-size:12px;margin:0;">If you did not request a password reset, please ignore this email.</p>
    </div>
  </div>
</body>
</html>
`;

const sendOtpEmail = async (email, code, purpose) => {
  const subject = purpose === 'EMAIL_VERIFICATION'
    ? 'Verify Your Email - FinRise Global'
    : 'Reset Your Password - FinRise Global';

  const html = purpose === 'EMAIL_VERIFICATION'
    ? verificationTemplate(code)
    : passwordResetTemplate(code);

  await transporter.sendMail({
    from: FROM,
    to: email,
    subject,
    html,
  });
};

module.exports = { sendOtpEmail };
