const Conversation = require('../models/Conversation');
const Message = require('../models/Message');

// ==================== USER ACTIONS ====================

exports.getUserConversations = async (req, res) => {
  try {
    const conversations = await Conversation.find({ user: req.user.id })
      .sort({ lastMessageAt: -1 });
    res.json({ conversations });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.getUserMessages = async (req, res) => {
  try {
    const { id } = req.params;
    const conversation = await Conversation.findOne({ _id: id, user: req.user.id });
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const messages = await Message.find({ conversation: id })
      .populate('sender', 'name role')
      .sort({ createdAt: 1 });

    // Mark admin messages as read by user
    await Message.updateMany(
      { conversation: id, senderRole: 'ADMIN', readAt: null },
      { readAt: new Date() }
    );
    await Conversation.findByIdAndUpdate(id, { unreadByUser: 0 });

    res.json({ messages, conversation });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.createUserConversation = async (req, res) => {
  try {
    const { subject, message } = req.body;
    if (!message) return res.status(400).json({ message: 'Message is required' });

    const conversation = await Conversation.create({
      user: req.user.id,
      subject: subject || 'Support Request',
      lastMessage: message,
      lastMessageAt: new Date(),
      lastMessageBy: req.user.id,
      unreadByAdmin: 1,
    });

    await Message.create({
      conversation: conversation._id,
      sender: req.user.id,
      senderRole: 'USER',
      message,
    });

    res.status(201).json({ conversation });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.sendUserMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message) return res.status(400).json({ message: 'Message is required' });

    const conversation = await Conversation.findOne({ _id: id, user: req.user.id });
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    if (conversation.status === 'CLOSED') return res.status(400).json({ message: 'Conversation is closed' });

    const msg = await Message.create({
      conversation: id,
      sender: req.user.id,
      senderRole: 'USER',
      message,
    });

    await Conversation.findByIdAndUpdate(id, {
      lastMessage: message,
      lastMessageAt: new Date(),
      lastMessageBy: req.user.id,
      $inc: { unreadByAdmin: 1 },
    });

    res.status(201).json({ message: msg });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.closeConversation = async (req, res) => {
  try {
    const { id } = req.params;
    const conversation = await Conversation.findOneAndUpdate(
      { _id: id, user: req.user.id },
      { status: 'CLOSED' },
      { new: true }
    );
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });
    res.json({ conversation });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ==================== ADMIN ACTIONS ====================

exports.adminGetAllConversations = async (req, res) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (status) filter.status = status;

    const total = await Conversation.countDocuments(filter);
    const conversations = await Conversation.find(filter)
      .populate('user', 'name email phone')
      .sort({ lastMessageAt: -1 })
      .skip((page - 1) * limit)
      .limit(Number(limit));

    res.json({ conversations, total, page: Number(page), pages: Math.ceil(total / limit) });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminGetMessages = async (req, res) => {
  try {
    const { id } = req.params;
    const conversation = await Conversation.findById(id).populate('user', 'name email phone');
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const messages = await Message.find({ conversation: id })
      .populate('sender', 'name role')
      .sort({ createdAt: 1 });

    // Mark user messages as read by admin
    await Message.updateMany(
      { conversation: id, senderRole: 'USER', readAt: null },
      { readAt: new Date() }
    );
    await Conversation.findByIdAndUpdate(id, { unreadByAdmin: 0 });

    res.json({ messages, conversation });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminSendMessage = async (req, res) => {
  try {
    const { id } = req.params;
    const { message } = req.body;
    if (!message) return res.status(400).json({ message: 'Message is required' });

    const conversation = await Conversation.findById(id);
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    const msg = await Message.create({
      conversation: id,
      sender: req.user.id,
      senderRole: 'ADMIN',
      message,
    });

    await Conversation.findByIdAndUpdate(id, {
      lastMessage: message,
      lastMessageAt: new Date(),
      lastMessageBy: req.user.id,
      status: 'IN_PROGRESS',
      $inc: { unreadByUser: 1 },
    });

    res.status(201).json({ message: msg });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminUpdateStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status' });
    }

    const conversation = await Conversation.findByIdAndUpdate(id, { status }, { new: true });
    if (!conversation) return res.status(404).json({ message: 'Conversation not found' });

    res.json({ conversation });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.adminGetUnreadCounts = async (req, res) => {
  try {
    const totalOpen = await Conversation.countDocuments({ status: { $in: ['OPEN', 'IN_PROGRESS'] } });
    const totalUnread = await Conversation.aggregate([
      { $match: { status: { $in: ['OPEN', 'IN_PROGRESS'] } } },
      { $group: { _id: null, total: { $sum: '$unreadByAdmin' } } },
    ]);
    res.json({
      totalOpen,
      totalUnread: totalUnread[0]?.total || 0,
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
