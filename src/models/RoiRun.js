const mongoose = require('mongoose');

// ==========================================
// ROI RUN — chunked/resumable manual ROI processing state
//
// Manual ROI used to run entirely inside one HTTP request, which timed
// out on serverless (Vercel) and on slow mobile connections. Each run is
// now persisted here so a single request only processes a small time
// budget ("chunk") of investments, then returns progress. The client
// keeps calling with the SAME runId until status is COMPLETED.
//
// Safety: this document is ONLY progress bookkeeping. The actual
// double-payment guard remains the unique { investment, roiDate } index
// on ROIHistory — if this doc is ever lost/stale, resuming still cannot
// pay anyone twice.
// ==========================================

const resultEntrySchema = new mongoose.Schema(
  {
    userId: { type: String, default: '' },
    name: { type: String, default: '' },
    email: { type: String, default: '' },
    investmentId: { type: String, default: '' },
    amount: { type: Number, default: 0 },
    credited: { type: Number, default: 0 },
    status: {
      type: String,
      enum: ['CREDITED', 'CAPPED', 'SKIPPED', 'FAILED'],
      default: 'SKIPPED',
    },
    reason: { type: String, default: '' },
  },
  { _id: false }
);

const roiRunSchema = new mongoose.Schema(
  {
    runId: {
      type: String,
      required: [true, 'runId is required'],
      unique: true,
      index: true,
    },

    type: {
      type: String,
      enum: ['MANUAL'],
      default: 'MANUAL',
    },

    percentage: {
      type: Number,
      required: true,
      min: 0,
    },

    // The single roiDate used for the WHOLE run (derived from runId).
    // Matches ROIHistory's unique { investment, roiDate } key so retries
    // of this run are idempotent at the database level.
    roiDate: {
      type: Date,
      required: true,
      index: true,
    },

    status: {
      type: String,
      enum: ['RUNNING', 'COMPLETED', 'FAILED'],
      default: 'RUNNING',
      index: true,
    },

    totalActive: {
      type: Number,
      default: 0,
    },

    // Snapshot of active investment _ids at run creation, in stable
    // order — the chunk cursor walks this list.
    investmentIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Investment',
      },
    ],

    // Investments already handled in this run (credited/capped/skipped).
    processedIds: [
      {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Investment',
      },
    ],

    counters: {
      processed: { type: Number, default: 0 },
      capped: { type: Number, default: 0 },
      skipped: { type: Number, default: 0 },
      failed: { type: Number, default: 0 },
      totalCredited: { type: Number, default: 0 },
    },

    results: {
      type: [resultEntrySchema],
      default: [],
    },

    errors: {
      type: [
        {
          investmentId: String,
          userId: String,
          message: String,
          _id: false,
        },
      ],
      default: [],
    },

    // Concurrency guard: a worker must renew this lease before processing
    // a chunk. A stale lease (crashed/timed-out worker) lets the next
    // request take over.
    leaseUntil: {
      type: Date,
      default: null,
    },

    completedAt: {
      type: Date,
      default: null,
    },

    createdBy: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  {
    timestamps: true,
  }
);

// Bound the results array so the document can never grow without limit.
roiRunSchema.pre('validate', function (next) {
  if (Array.isArray(this.results) && this.results.length > 500) {
    this.results = this.results.slice(0, 500);
  }
  if (Array.isArray(this.errors) && this.errors.length > 500) {
    this.errors = this.errors.slice(0, 500);
  }
  next();
});

// Progress lookups: by runId (client poll) and latest run of a status.
roiRunSchema.index({ createdAt: -1 });

const RoiRun = mongoose.model('RoiRun', roiRunSchema);

module.exports = RoiRun;
