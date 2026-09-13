const express = require('express');
const router = express.Router();
const {
  createAnnouncement,
  listAnnouncements,
  updateAnnouncement,
  deleteAnnouncement,
  toggleAnnouncement,
  getActiveAnnouncements,
} = require('../controllers/announcementController');
const { authenticate, authorizeAdmin } = require('../middleware/authMiddleware');

// Admin routes
router.post('/', authenticate, authorizeAdmin, createAnnouncement);
router.get('/', authenticate, authorizeAdmin, listAnnouncements);
router.put('/:id', authenticate, authorizeAdmin, updateAnnouncement);
router.delete('/:id', authenticate, authorizeAdmin, deleteAnnouncement);
router.patch('/:id/toggle', authenticate, authorizeAdmin, toggleAnnouncement);

// User-facing (public within auth)
router.get('/active', authenticate, getActiveAnnouncements);

module.exports = router;
