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

// ==========================================
// Transactional emails (deposit / withdrawal / income)
// Same minimal branded layout as OTP templates.
// ==========================================

const fmtAmount = (amount) => `$${Number(amount || 0).toFixed(2)}`;
const todayStr = () => new Date().toISOString().split('T')[0];

const transactionEmailLayout = ({ heading, intro, details = [], footer }) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#f4f4f7;font-family:Arial,sans-serif;">
  <div style="max-width:480px;margin:40px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,0.08);">
    <div style="background:linear-gradient(135deg,#6366f1,#8b5cf6);padding:32px 24px;text-align:center;">
      <h1 style="color:#fff;margin:0;font-size:22px;">FinRise Global</h1>
    </div>
    <div style="padding:32px 24px;text-align:center;">
      <h2 style="color:#1a1a2e;margin:0 0 12px;">${heading}</h2>
      <p style="color:#666;font-size:14px;margin:0 0 24px;">${intro}</p>
      ${details.length ? `
      <div style="background:#f4f4f7;border-radius:8px;padding:12px 20px;margin:0 0 24px;text-align:left;">
        ${details.map(([label, value]) => `
        <div style="display:flex;justify-content:space-between;gap:16px;padding:8px 0;font-size:14px;${label !== details[details.length - 1][0] ? 'border-bottom:1px solid #e5e7eb;' : ''}">
          <span style="color:#666;">${label}</span>
          <span style="color:#1a1a2e;font-weight:bold;text-align:right;">${value}</span>
        </div>`).join('')}
      </div>` : ''}
      <div style="background:#fff8e6;border:1px solid #f5d76e;border-radius:8px;padding:12px 16px;margin:0 0 16px;">
        <p style="margin:0;font-size:14px;font-weight:bold;color:#8a6d00;text-align:center;">
          Also check your Spam/Junk folder for this email.
        </p>
      </div>
      <p style="color:#999;font-size:12px;margin:0;">${footer}</p>
    </div>
  </div>
</body>
</html>
`;

const sendSystemEmail = async (to, subject, html) => {
  await transporter.sendMail({ from: FROM, to, subject, html });
};

const sendDepositApprovedEmail = (email, amount) =>
  sendSystemEmail(email, 'Deposit Approved - FinRise Global', transactionEmailLayout({
    heading: 'Deposit Approved',
    intro: 'Your deposit has been approved and credited to your Main Wallet.',
    details: [
      ['Amount', fmtAmount(amount)],
      ['Date', todayStr()],
      ['Status', 'Approved'],
    ],
    footer: 'If you did not request this deposit, please contact support immediately.',
  }));

const sendDepositRejectedEmail = (email, amount) =>
  sendSystemEmail(email, 'Deposit Rejected - FinRise Global', transactionEmailLayout({
    heading: 'Deposit Rejected',
    intro: 'Your deposit request has been reviewed and rejected. No amount was credited.',
    details: [
      ['Amount', fmtAmount(amount)],
      ['Date', todayStr()],
      ['Status', 'Rejected'],
    ],
    footer: 'If you believe this is a mistake, please contact support.',
  }));

const sendWithdrawalApprovedEmail = (email, amount, netAmount = null) =>
  sendSystemEmail(email, 'Withdrawal Approved - FinRise Global', transactionEmailLayout({
    heading: 'Withdrawal Approved',
    intro: 'Your withdrawal request has been approved and is being processed.',
    details: [
      ['Amount', fmtAmount(amount)],
      ...(netAmount != null && Number(netAmount) !== Number(amount)
        ? [['You Receive', fmtAmount(netAmount)]]
        : []),
      ['Date', todayStr()],
      ['Status', 'Approved'],
    ],
    footer: 'Thank you for using FinRise Global.',
  }));

const sendWithdrawalRejectedEmail = (email, amount, reason = '') =>
  sendSystemEmail(email, 'Withdrawal Rejected - FinRise Global', transactionEmailLayout({
    heading: 'Withdrawal Rejected',
    intro: 'Your withdrawal request has been rejected. The held amount has been refunded to your wallet.',
    details: [
      ['Amount', fmtAmount(amount)],
      ['Date', todayStr()],
      ['Status', 'Rejected'],
      ...(reason ? [['Reason', reason]] : []),
    ],
    footer: 'If you have questions, please contact support.',
  }));

const sendDirectIncomeEmail = (email, amount) =>
  sendSystemEmail(email, 'Direct Income Received - FinRise Global', transactionEmailLayout({
    heading: 'Direct Income Received',
    intro: 'You have received direct income from a downline investment.',
    details: [
      ['Amount', fmtAmount(amount)],
      ['Date', todayStr()],
      ['Type', 'Direct Income'],
    ],
    footer: 'This amount has been credited to your Main Wallet.',
  }));

module.exports = {
  sendOtpEmail,
  sendDepositApprovedEmail,
  sendDepositRejectedEmail,
  sendWithdrawalApprovedEmail,
  sendWithdrawalRejectedEmail,
  sendDirectIncomeEmail,
};
