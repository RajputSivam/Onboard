class HttpError extends Error {
  constructor(status, code, message, extra = {}) {
    super(message); this.status = status; this.code = code; this.extra = extra;
  }
}
module.exports = { HttpError };
