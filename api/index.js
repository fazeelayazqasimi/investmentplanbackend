const dotenv = require('dotenv');

// Load environment variables (Vercel injects them from Project Settings,
// but this also supports local testing of the serverless handler).
dotenv.config({ path: require('path').join(__dirname, '..', '.env') });

const app = require('../src/app');
const connectDB = require('../src/config/db');

// ==========================================
// MONGOOSE CONNECTION CACHE
// In serverless environments, module-level variables survive across
// warm invocations. We cache the connection promise so subsequent
// requests reuse the existing connection instead of reconnecting.
// ==========================================
let cached = global._mongoose;
if (!cached) {
  cached = global._mongoose = { conn: null, promise: null };
}

/**
 * Vercel serverless handler.
 * Every incoming request passes through here. On cold start, we
 * establish the MongoDB connection and cache it. On warm invocations,
 * we reuse the cached connection.
 */
module.exports = async (req, res) => {
  // Ensure MongoDB is connected before handling any request
  if (!cached.promise) {
    console.log('[Vercel] Cold start — connecting to MongoDB...');
    cached.promise = connectDB()
      .then((conn) => {
        console.log('[Vercel] MongoDB connected successfully');
        cached.conn = conn;
        return conn;
      })
      .catch((err) => {
        // Reset the promise so the next request can retry
        cached.promise = null;
        throw err;
      });
  }

  try {
    await cached.promise;
  } catch (err) {
    console.error('[Vercel] MongoDB connection failed:', err.message);
    // Return a clean error to the client instead of crashing
    if (!res.headersSent) {
      return res.status(503).json({
        success: false,
        message: 'Unable to connect to the server. Please try again.',
      });
    }
    return;
  }

  return app(req, res);
};
