const mongoose = require('mongoose');

/**
 * Establishes connection to MongoDB using Mongoose.
 *
 * This function is idempotent: if a connection is already established,
 * it returns the existing connection immediately. Safe for both
 * long-running servers and serverless environments.
 *
 * Never calls process.exit() — instead throws on failure so callers
 * can handle errors gracefully (e.g. return 503 to the client).
 */
const connectDB = async () => {
  // If already connected, return the existing connection
  if (mongoose.connection.readyState === 1) {
    return mongoose.connection;
  }

  try {
    const conn = await mongoose.connect(process.env.MONGO_URI, {
      // Fail fast if MongoDB is unreachable (5s instead of default 10s)
      serverSelectionTimeoutMS: 5000,
      // Limit connection pool for serverless efficiency
      maxPoolSize: 10,
      // Don't keep idle connections open forever
      minPoolSize: 0,
    });

    console.log(`MongoDB Connected: ${conn.connection.host}`);

    mongoose.connection.on('error', (err) => {
      console.error(`MongoDB connection error: ${err.message}`);
    });

    mongoose.connection.on('disconnected', () => {
      console.warn('MongoDB disconnected. Attempting to reconnect is handled by the driver.');
    });

    return conn;
  } catch (error) {
    console.error(`Error connecting to MongoDB: ${error.message}`);
    // Throw instead of process.exit — let the caller decide what to do.
    // In serverless: return 503 to client.
    // In traditional server: the caller can exit or retry.
    throw error;
  }
};

module.exports = connectDB;
