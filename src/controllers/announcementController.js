const Announcement = require('../models/Announcement');

// ==================== ADMIN CRUD ====================

exports.createAnnouncement = async (req, res) => {
  try {
    const { title, message, type, priority, showBanner, showModal, expiresAt } = req.body;

    if (!title || !message) {
      return res.status(400).json({ message: 'Title and message are required' });
    }

    const announcement = await Announcement.create({
      title,
      message,
      type: type || 'INFO',
      priority: priority || 'MEDIUM',
      showBanner: showBanner !== false,
      showModal: showModal || false,
      expiresAt: expiresAt || null,
      createdBy: req.user._id,
    });

    res.status(201).json({ announcement });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.listAnnouncements = async (req, res) => {
  try {
    const { active, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (active !== undefined) filter.active = active === 'true';

    const total = await Announcement.countDocuments(filter);
    const announcements = await Announcement.find(filter)
      .populate('createdBy', 'name email')
      .sort({ createdAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.json({ announcements, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.updateAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    const updates = req.body;

    const announcement = await Announcement.findByIdAndUpdate(id, updates, { new: true, runValidators: true });
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });

    res.json({ announcement });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.deleteAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    const announcement = await Announcement.findByIdAndDelete(id);
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });

    res.json({ message: 'Announcement deleted' });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.toggleAnnouncement = async (req, res) => {
  try {
    const { id } = req.params;
    const announcement = await Announcement.findById(id);
    if (!announcement) return res.status(404).json({ message: 'Announcement not found' });

    announcement.active = !announcement.active;
    await announcement.save();

    res.json({ announcement });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ==================== USER-FACING ====================

exports.getActiveAnnouncements = async (req, res) => {
  try {
    const now = new Date();
    const announcements = await Announcement.find({
      active: true,
      $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }],
    })
      .select('title message type priority showBanner showModal createdAt')
      .sort({ priority: -1, createdAt: -1 });

    res.json({ announcements });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
