const mongoose = require('mongoose');

const messageSchema = new mongoose.Schema(
  {
    conversation: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Conversation',
      required: true,
    },
    sender: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },
    senderRole: {
      type: String,
      enum: ['USER', 'ADMIN'],
      required: true,
    },
    message: {
      type: String,
      required: function () { return !this.images || this.images.length === 0; },
      trim: true,
      maxlength: [5000, 'Message cannot exceed 5000 characters'],
      default: '',
    },
    images: [{
      url: { type: String, required: true },
      publicId: { type: String, required: true },
    }],
    readAt: {
      type: Date,
      default: null,
    },
  },
  { timestamps: true }
);

messageSchema.index({ conversation: 1, createdAt: 1 });

module.exports = mongoose.model('Message', messageSchema);
