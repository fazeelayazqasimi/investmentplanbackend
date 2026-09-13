const asyncHandler = require('express-async-handler');
const BankAccount = require('../models/BankAccount');

const getActiveAccounts = asyncHandler(async (req, res) => {
  const accounts = await BankAccount.find({ isActive: true })
    .sort({ displayOrder: 1, createdAt: 1 })
    .select('-createdBy -__v')
    .lean();
  res.status(200).json({ success: true, data: { accounts } });
});

const getAllAccounts = asyncHandler(async (req, res) => {
  const accounts = await BankAccount.find()
    .sort({ displayOrder: 1, createdAt: -1 })
    .populate('createdBy', 'name email')
    .lean();
  res.status(200).json({ success: true, data: { accounts } });
});

const createAccount = asyncHandler(async (req, res) => {
  const { bankName, accountHolder, accountNumber, iban, accountType, displayOrder } = req.body;

  if (!bankName || !accountHolder || !accountNumber) {
    return res.status(400).json({
      success: false,
      message: 'Bank name, account holder, and account number are required',
    });
  }

  const account = await BankAccount.create({
    bankName: bankName.trim(),
    accountHolder: accountHolder.trim(),
    accountNumber: accountNumber.trim(),
    iban: (iban || '').trim(),
    accountType: accountType || 'BANK',
    displayOrder: Number(displayOrder) || 0,
    createdBy: req.user.id,
  });

  res.status(201).json({
    success: true,
    message: 'Bank account added successfully',
    data: { account },
  });
});

const updateAccount = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { bankName, accountHolder, accountNumber, iban, accountType, isActive, displayOrder } = req.body;

  const account = await BankAccount.findById(id);
  if (!account) {
    return res.status(404).json({ success: false, message: 'Bank account not found' });
  }

  if (bankName !== undefined) account.bankName = bankName.trim();
  if (accountHolder !== undefined) account.accountHolder = accountHolder.trim();
  if (accountNumber !== undefined) account.accountNumber = accountNumber.trim();
  if (iban !== undefined) account.iban = iban.trim();
  if (accountType !== undefined) account.accountType = accountType;
  if (isActive !== undefined) account.isActive = isActive;
  if (displayOrder !== undefined) account.displayOrder = Number(displayOrder);

  await account.save();

  res.status(200).json({
    success: true,
    message: 'Bank account updated successfully',
    data: { account },
  });
});

const deleteAccount = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const account = await BankAccount.findById(id);
  if (!account) {
    return res.status(404).json({ success: false, message: 'Bank account not found' });
  }

  await BankAccount.findByIdAndDelete(id);

  res.status(200).json({
    success: true,
    message: 'Bank account deleted successfully',
  });
});

module.exports = {
  getActiveAccounts,
  getAllAccounts,
  createAccount,
  updateAccount,
  deleteAccount,
};
