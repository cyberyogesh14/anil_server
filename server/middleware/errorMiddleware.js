const errorHandler = (err, req, res, _next) => {
  let error = { ...err };
  error.message = err.message;

  console.error(err.message);

  if (err.name === 'CastError') {
    return res.status(400).json({
      success: false,
      message: 'Invalid ID format',
    });
  }

  if (err.code === 11000) {
    const field = Object.keys(err.keyValue)[0];
    return res.status(409).json({
      success: false,
      message: `Duplicate value for ${field}`,
    });
  }

  if (err.name === 'ValidationError') {
    const messages = Object.values(err.errors).map((e) => e.message);
    return res.status(422).json({
      success: false,
      message: messages.join(', '),
    });
  }

  if (err.name === 'JsonWebTokenError') {
    return res.status(401).json({
      success: false,
      message: 'Invalid token',
    });
  }

  if (err.name === 'TokenExpiredError') {
    return res.status(401).json({
      success: false,
      message: 'Token expired',
    });
  }

  if (err.name === 'MulterError') {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({
        success: false,
        message: 'File size too large. Maximum 5MB allowed.',
      });
    }
    return res.status(400).json({
      success: false,
      message: err.message,
    });
  }

  // Audit finding F-08 (defence in depth). User-supplied input is now escaped
  // before it reaches the regex engine, so this should be unreachable - but if any
  // route builds a RegExp from untrusted input in future, a malformed pattern is a
  // client error, not a server fault. Returning 400 instead of 500 also stops the
  // internal "Invalid regular expression ..." text from ever reaching a caller.
  if (err instanceof SyntaxError || err.name === 'SyntaxError') {
    return res.status(400).json({
      success: false,
      message: 'Invalid search input',
    });
  }

  const statusCode = err.statusCode || 500;
  const message =
    process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message;

  return res.status(statusCode).json({
    success: false,
    message,
  });
};

module.exports = errorHandler;
