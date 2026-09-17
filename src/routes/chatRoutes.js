const express = require('express');
const router = express.Router();
const chat = require('../controllers/chatController');
const { authenticate, authorizeAdmin } = require('../middleware/authMiddleware');
const { uploadChatImages } = require('../middleware/uploadMiddleware');

// User routes
router.get('/user/conversations', authenticate, chat.getUserConversations);
router.get('/user/conversations/:id', authenticate, chat.getUserMessages);
router.post('/user/conversations', authenticate, uploadChatImages, chat.createUserConversation);
router.post('/user/conversations/:id/messages', authenticate, uploadChatImages, chat.sendUserMessage);
router.patch('/user/conversations/:id/close', authenticate, chat.closeConversation);

// Admin routes
router.get('/admin/conversations', authenticate, authorizeAdmin, chat.adminGetAllConversations);
router.get('/admin/unread', authenticate, authorizeAdmin, chat.adminGetUnreadCounts);
router.get('/admin/conversations/:id', authenticate, authorizeAdmin, chat.adminGetMessages);
router.post('/admin/conversations/:id/messages', authenticate, authorizeAdmin, chat.adminSendMessage);
router.patch('/admin/conversations/:id/status', authenticate, authorizeAdmin, chat.adminUpdateStatus);

module.exports = router;
