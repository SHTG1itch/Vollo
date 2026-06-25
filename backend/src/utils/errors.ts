/** A typed HTTP error the error-handling middleware knows how to serialise. */
export class ApiError extends Error {
  status: number;
  code: string;
  details?: unknown;

  constructor(status: number, code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }

  static badRequest(message: string, details?: unknown) {
    return new ApiError(400, 'bad_request', message, details);
  }
  static unauthorized(message = 'Authentication required') {
    return new ApiError(401, 'unauthorized', message);
  }
  static forbidden(message = 'Not allowed') {
    return new ApiError(403, 'forbidden', message);
  }
  static notFound(message = 'Not found') {
    return new ApiError(404, 'not_found', message);
  }
  static conflict(message: string, details?: unknown) {
    return new ApiError(409, 'conflict', message, details);
  }
  static internal(message = 'Something went wrong') {
    return new ApiError(500, 'internal_error', message);
  }
}
