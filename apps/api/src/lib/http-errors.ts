// Thrown by route handlers and services when the request cannot be completed.
// The response shape lives in the app error handler so every error of a given
// kind looks the same, and so no handler ever calls reply.send(error) and leaks
// a stack trace.

export class NotFoundError extends Error {
  readonly statusCode = 404;

  constructor(message = "Resource not found") {
    super(message);
    this.name = "NotFoundError";
  }
}

// Who you are is the problem: no token, an expired one, or an account that can
// no longer sign in. The client should stop reusing the credential and
// re-authenticate.
export class UnauthorizedError extends Error {
  readonly statusCode = 401;

  constructor(message = "Kimlik dogrulama gerekli") {
    super(message);
    this.name = "UnauthorizedError";
  }
}

// Who you are is fine; what you asked for is not allowed. Re-authenticating
// will not help, which is exactly what separates this from a 401.
export class ForbiddenError extends Error {
  readonly statusCode = 403;

  constructor(message = "Bu islem icin yetkiniz yok") {
    super(message);
    this.name = "ForbiddenError";
  }
}

// A rule about the state of the data rejected the request: a duplicate, a
// hierarchy cycle, a season that still has records hanging off it. Distinct
// from a 400 because the payload itself is well formed.
export class ConflictError extends Error {
  readonly statusCode = 409;

  constructor(message = "Istek mevcut kayitlarla celisiyor") {
    super(message);
    this.name = "ConflictError";
  }
}
