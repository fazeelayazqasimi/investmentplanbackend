const { validationResult } = require('express-validator');

/**
 * Runs after express-validator rule chains have executed on the request.
 * If any validation errors were collected, responds with a standardized
 * 400 error. Otherwise, passes control to the next handler (the controller).
 */
const validateRequest = (req, res, next) => {
  const errors = validationResult(req);

  if (!errors.isEmpty()) {
    const formattedErrors = errors.array().map((err) => ({
      field: err.path,
      message: err.msg,
    }));

    return res.status(400).json({
      success: false,
      message: 'Validation failed',
      errors: formattedErrors,
    });
  }

  next();
};

module.exports = validateRequest;