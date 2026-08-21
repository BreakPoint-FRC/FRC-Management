// Thrown by route handlers when a lookup returns nothing. The response shape
// lives in the app error handler so every 404 looks the same.
export class NotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message = "Resource not found") {
    super(message);
    this.name = "NotFoundError";
  }
}
