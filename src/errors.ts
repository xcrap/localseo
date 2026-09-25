// Errors that map to a specific HTTP status. Route handlers let these bubble up
// to `safe()` in index.ts, which answers with `{ error }` and this status.
export class HttpError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = "HttpError";
    this.status = status;
  }
}

export function notFound(message: string) {
  return new HttpError(404, message);
}

export function badRequest(message: string) {
  return new HttpError(400, message);
}
