const mongoose = require('mongoose');

const conversationSchema = new mongoose.Schema(
  {
    user: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    subject: {
      type: String,
      trim: true,
      maxlength: [200, 'Subject cannot exceed 200 characters'],
      default: 'Support Request',
    },
    status: {
      type: String,
      enum: ['OPEN', 'IN_PROGRESS', 'RESOLVED', 'CLOSED'],
      default: 'OPEN',
    },
    lastMessage: {
      type: String,
      trim: true,
      default: '',
    },
    lastMessageAt: {
      type: Date,
      default: Date.now,
    },
    lastMessageBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
    },
    unreadByUser: {
      type: Number,
      default: 0,
    },
    unreadByAdmin: {
      type: Number,
      default: 0,
    },
  },
  { timestamps: true }
);

conversationSchema.index({ user: 1, status: 1 });
conversationSchema.index({ status: 1, lastMessageAt: -1 });

module.exports = mongoose.model('Conversation', conversationSchema);
