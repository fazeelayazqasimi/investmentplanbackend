const Announcement = require('../models/Announcement');
const { cloudinary } = require('../middleware/uploadMiddleware');

const deleteCloudinaryImages = async (images) => {
  if (!images || images.length === 0) return;
  for (const img of images) {
    try {
      if (img.publicId) await cloudinary.uploader.destroy(img.publicId);
    } catch (_) {}
  }
};

// ==================== ADMIN CRUD ====================

exports.createAnnouncement = async (req, res) => {
  try {
    const { title, message, type, priority, showBanner, showModal, expiresAt } = req.body;

    if (!title || !message) {
      if (req.files && req.files.length > 0) {
        for (const f of req.files) {
          try { await cloudinary.uploader.destroy(f.filename); } catch (_) {}
        }
      }
      return res.status(400).json({ message: 'Title and message are required' });
    }

    const images = (req.files || []).map((f) => ({
      url: f.path,
      publicId: f.filename,
    }));

    const announcement = await Announcement.create({
      title,
      message,
      type: type || 'INFO',
      priority: priority || 'MEDIUM',
      showBanner: showBanner !== 'false' && showBanner !== false,
      showModal: showModal === 'true' || showModal === true,
      expiresAt: expiresAt || null,
      images,
      createdBy: req.user.id,
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
    const announcement = await Announcement.findById(id);
    if (!announcement) {
      if (req.files && req.files.length > 0) {
        for (const f of req.files) {
          try { await cloudinary.uploader.destroy(f.filename); } catch (_) {}
        }
      }
      return res.status(404).json({ message: 'Announcement not found' });
    }

    const { title, message, type, priority, showBanner, showModal, expiresAt, removedImages } = req.body;

    if (title !== undefined) announcement.title = title;
    if (message !== undefined) announcement.message = message;
    if (type !== undefined) announcement.type = type;
    if (priority !== undefined) announcement.priority = priority;
    if (showBanner !== undefined) announcement.showBanner = showBanner !== 'false' && showBanner !== false;
    if (showModal !== undefined) announcement.showModal = showModal === 'true' || showModal === true;
    if (expiresAt !== undefined) announcement.expiresAt = expiresAt || null;

    if (removedImages) {
      const toRemove = JSON.parse(removedImages);
      if (toRemove.length > 0) {
        for (const publicId of toRemove) {
          try { await cloudinary.uploader.destroy(publicId); } catch (_) {}
        }
        announcement.images = announcement.images.filter((img) => !toRemove.includes(img.publicId));
      }
    }

    if (req.files && req.files.length > 0) {
      const newImages = req.files.map((f) => ({ url: f.path, publicId: f.filename }));
      announcement.images.push(...newImages);
    }

    await announcement.save();

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

    await deleteCloudinaryImages(announcement.images);

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
      .select('title message type priority showBanner showModal images createdAt')
      .sort({ priority: -1, createdAt: -1 });

    res.json({ announcements });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
