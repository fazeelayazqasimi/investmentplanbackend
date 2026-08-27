const dotenv = require('dotenv');

// Load environment variables before anything else runs
dotenv.config();

const app = require('./app');
const connectDB = require('./config/db');
const roiService = require('./services/roiService');

const PORT = process.env.PORT || 5000;

// Handle uncaught synchronous exceptions
process.on('uncaughtException', (err) => {
  console.error(`Uncaught Exception: ${err.message}`);
  process.exit(1);
});

const startServer = async () => {
  try {
    // Connect to MongoDB first
    await connectDB();

    const server = app.listen(PORT, () => {
      console.log(
        `Server running in ${process.env.NODE_ENV || 'development'} mode on port ${PORT}`
      );
    });

    // Handle unhandled promise rejections (e.g. DB errors after connection)
    process.on('unhandledRejection', (err) => {
      console.error(`Unhandled Rejection: ${err.message}`);
      server.close(() => process.exit(1));
    });

    // Graceful shutdown
    process.on('SIGTERM', () => {
      console.log('SIGTERM received. Shutting down gracefully...');
      server.close(() => {
        console.log('Process terminated.');
      });
    });

    // ==========================================
    // ROI DISTRIBUTION SCHEDULER
    // Runs once per day to credit ROI for all active investments
    // according to the configured ROI system. Only does work when
    // roiProcessingEnabled is true (see SystemSettings).
    // ==========================================
    const ROI_INTERVAL_MS = 24 * 60 * 60 * 1000;
    setInterval(async () => {
      try {
        const result = await roiService.processAllActiveInvestments(new Date());
        if (result.processed || result.skipped) {
          console.log(
            `[ROI] processed=${result.processed} skipped=${result.skipped}` +
              (result.message ? ` (${result.message})` : '')
          );
        }
      } catch (err) {
        console.error(`[ROI] scheduler error: ${err.message}`);
      }
    }, ROI_INTERVAL_MS);
  } catch (error) {
    console.error(`Failed to start server: ${error.message}`);
    process.exit(1);
  }
};

startServer();