const express = require('express');
const router = express.Router();
const { authenticate, authorizeAdmin } = require('../middleware/authMiddleware');
const {
  getRanks,
  createRank,
  updateRank,
  deleteRank,
  toggleRank,
  recalculateRanks,
  getMyRank,
  getMyRankHistory,
  getAllRanksPublic,
} = require('../controllers/rankController');

router.get('/all', authenticate, getAllRanksPublic);
router.get('/my-rank', authenticate, getMyRank);
router.get('/my-history', authenticate, getMyRankHistory);

router.get('/', authenticate, authorizeAdmin, getRanks);
router.post('/', authenticate, authorizeAdmin, createRank);
router.put('/:id', authenticate, authorizeAdmin, updateRank);
router.delete('/:id', authenticate, authorizeAdmin, deleteRank);
router.patch('/:id/toggle', authenticate, authorizeAdmin, toggleRank);
router.post('/recalculate', authenticate, authorizeAdmin, recalculateRanks);

module.exports = router;
