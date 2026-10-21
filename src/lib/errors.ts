export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: unknown,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, details?: unknown) => new AppError(400, "BAD_REQUEST", message, details);
export const unauthorized = (message = "Please sign in to continue.") => new AppError(401, "UNAUTHORIZED", message);
export const forbidden = (message = "You do not have permission to perform this action.") =>
  new AppError(403, "FORBIDDEN", message);
export const notFound = (what = "Resource") => new AppError(404, "NOT_FOUND", `${what} not found.`);
export const conflict = (message: string, details?: unknown) => new AppError(409, "CONFLICT", message, details);
export const unprocessable = (message: string, details?: unknown) =>
  new AppError(422, "VALIDATION_FAILED", message, details);
export const tooManyRequests = (message = "Too many requests. Please wait a moment and try again.") =>
  new AppError(429, "RATE_LIMITED", message);
