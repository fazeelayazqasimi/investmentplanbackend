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

// ==========================================
// Shared green brand tokens (inline styles only)
// ==========================================
const PAGE_BG = '#eef6f1';
const CARD_BG = '#ffffff';
const GRADIENT = 'linear-gradient(135deg,#10b981,#047857)';
const HEADING = '#065f46';
const BODY_TEXT = '#4b5563';
const MUTED = '#9ca3af';
const ACCENT = '#047857';
const SOFT_GREEN = '#ecfdf5';
const BORDER = '#e5e7eb';

const shell = (content) => `
<!DOCTYPE html>
<html>
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:${PAGE_BG};font-family:Arial,Helvetica,sans-serif;-webkit-font-smoothing:antialiased;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;">FinRise Global secure notification</div>
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${PAGE_BG};padding:32px 12px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:500px;background:${CARD_BG};border-radius:16px;overflow:hidden;box-shadow:0 6px 24px rgba(4,120,87,0.12);border:1px solid #dbeee4;">
        ${content}
      </table>
      <p style="color:${MUTED};font-size:11px;margin:16px 0 0;">&copy; FinRise Global &middot; Secure financial notifications</p>
    </td></tr>
  </table>
</body>
</html>
`;

const brandHeader = (title) => `
        <tr><td style="background:${GRADIENT};padding:30px 24px;text-align:center;border-bottom:4px solid #065f46;">
          <div style="display:inline-block;background:rgba(255,255,255,0.18);border:1px solid rgba(255,255,255,0.35);border-radius:999px;padding:5px 16px;margin:0 0 10px;">
            <span style="color:#ffffff;font-size:11px;font-weight:bold;letter-spacing:2px;text-transform:uppercase;">FinRise Global</span>
          </div>
          <div style="color:#ffffff;font-size:24px;font-weight:bold;margin:0;">${title}</div>
          <div style="color:#d1fae5;font-size:13px;margin:6px 0 0;">Trusted &middot; Secure &middot; Transparent</div>
        </td></tr>`;

const brandFooter = (text) => `
        <tr><td style="background:#f0faf5;border-top:1px solid #d7eee2;padding:18px 24px;text-align:center;">
          <p style="color:${BODY_TEXT};font-size:13px;margin:0 0 8px;">${text}</p>
          <p style="color:${MUTED};font-size:11px;margin:0;">This is an automated email from FinRise Global. Please do not reply.</p>
        </td></tr>`;

const verificationTemplate = (code) => shell(`
${brandHeader('Verify Your Email')}
        <tr><td style="padding:32px 28px;text-align:center;">
          <p style="color:${BODY_TEXT};font-size:14px;line-height:1.6;margin:0 0 22px;">Use the code below to verify your email address. This code expires in <strong style="color:${HEADING};">1 minute</strong>.</p>
          <div style="background:${SOFT_GREEN};border:2px dashed #34d399;border-radius:12px;padding:22px 16px;margin:0 0 20px;">
            <span style="font-size:38px;font-weight:bold;letter-spacing:10px;color:${ACCENT};">${code}</span>
          </div>
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin:0 0 4px;">
            <p style="margin:0;font-size:12px;color:#92400e;">If you did not create an account, please ignore this email.</p>
          </div>
        </td></tr>
${brandFooter('Stay secure — never share your OTP with anyone.')}
`);

const passwordResetTemplate = (code) => shell(`
${brandHeader('Password Reset')}
        <tr><td style="padding:32px 28px;text-align:center;">
          <p style="color:${BODY_TEXT};font-size:14px;line-height:1.6;margin:0 0 22px;">Use the code below to reset your password. This code expires in <strong style="color:${HEADING};">1 minute</strong>.</p>
          <div style="background:${SOFT_GREEN};border:2px dashed #34d399;border-radius:12px;padding:22px 16px;margin:0 0 20px;">
            <span style="font-size:38px;font-weight:bold;letter-spacing:10px;color:${ACCENT};">${code}</span>
          </div>
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin:0 0 4px;">
            <p style="margin:0;font-size:12px;color:#92400e;">If you did not request a password reset, please ignore this email.</p>
          </div>
        </td></tr>
${brandFooter('If this wasn\'t you, your password stays unchanged.')}
`);

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
// Green branded layout shared by all transaction emails.
// ==========================================

const fmtAmount = (amount) => `$${Number(amount || 0).toFixed(2)}`;
const todayStr = () => new Date().toISOString().split('T')[0];

const statusPill = (status) => {
  if (!status) return '';
  const s = String(status).toLowerCase();
  const palette =
    s.includes('reject') || s.includes('fail')
      ? { bg: '#fee2e2', fg: '#991b1b', border: '#fecaca' }
      : s.includes('approv') || s.includes('success') || s.includes('complete') || s.includes('received')
        ? { bg: '#dcfce7', fg: '#166534', border: '#bbf7d0' }
        : { bg: '#fef3c7', fg: '#92400e', border: '#fde68a' };
  return `
          <div style="display:inline-block;background:${palette.bg};color:${palette.fg};border:1px solid ${palette.border};border-radius:999px;padding:6px 18px;font-size:12px;font-weight:bold;letter-spacing:1px;text-transform:uppercase;margin:0 0 18px;">${status}</div>`;
};

const transactionEmailLayout = ({ heading, intro, details = [], status = '', footer }) => shell(`
${brandHeader(heading)}
        <tr><td style="padding:30px 28px 8px;text-align:center;">
          ${status ? statusPill(status) : ''}
          <p style="color:${BODY_TEXT};font-size:14px;line-height:1.6;margin:0 0 22px;">${intro}</p>
          ${details.length ? `
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${SOFT_GREEN};border:1px solid #cdeee0;border-radius:12px;padding:6px 18px;">
            ${details.map(([label, value], i) => `
            <tr>
              <td style="padding:12px 0;font-size:14px;color:${BODY_TEXT};${i < details.length - 1 ? `border-bottom:1px solid #d7eee2;` : ''}">${label}</td>
              <td style="padding:12px 0;font-size:14px;font-weight:bold;color:${HEADING};text-align:right;${i < details.length - 1 ? `border-bottom:1px solid #d7eee2;` : ''}">${value}</td>
            </tr>`).join('')}
          </table>` : ''}
          <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:8px;padding:10px 14px;margin:20px 0 4px;">
            <p style="margin:0;font-size:12px;color:#92400e;text-align:center;">Also check your Spam/Junk folder for this email.</p>
          </div>
        </td></tr>
${brandFooter(footer)}
`);

const sendSystemEmail = async (to, subject, html) => {
  await transporter.sendMail({ from: FROM, to, subject, html });
};

const sendDepositApprovedEmail = (email, amount) =>
  sendSystemEmail(email, 'Deposit Approved - FinRise Global', transactionEmailLayout({
    heading: 'Deposit Approved',
    intro: 'Your deposit has been approved and credited to your Main Wallet.',
    status: 'Approved',
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
    status: 'Rejected',
    details: [
      ['Amount', fmtAmount(amount)],
      ['Date', todayStr()],
      ['Status', 'Rejected'],
    ],
    footer: 'If you believe this is a mistake, please contact support.',
  }));

const sendWithdrawalApprovedEmail = (email, amount, netAmount = null, fee = null) =>
  sendSystemEmail(email, 'Withdrawal Approved - FinRise Global', transactionEmailLayout({
    heading: 'Withdrawal Approved',
    intro: 'Your withdrawal request has been approved and is being processed.',
    status: 'Approved',
    details: [
      ['Requested Amount', fmtAmount(amount)],
      ...(fee != null && Number(fee) > 0
        ? [['Fee Deducted', `-${fmtAmount(fee)}`]]
        : []),
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
    status: 'Rejected',
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
    status: 'Received',
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
