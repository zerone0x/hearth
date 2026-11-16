/**
 * A request body that is read only when a handler asks for it (#32).
 *
 * Every API handler calls `authorize` first (AGENTS.md, PRD §7), including
 * before it parses the body: a route passes a `RequestBody` to its service,
 * which reads it after `authorize` and its visibility checks. A body that is
 * not JSON is then answered, and audited, like any other bad input, and a
 * caller who may not act learns nothing from what it sent.
 */

import { HearthError } from "@hearth/core";

export class RequestBody<T> {
  readonly #read: () => Promise<T>;

  constructor(read: () => Promise<T>) {
    this.#read = read;
  }

  read(): Promise<T> {
    return this.#read();
  }
}

/**
 * The body of a request as JSON, read on demand. A body that is not JSON
 * rejects with a `user`-owned `HearthError` whose code is `code`.
 */
export function jsonBody(
  req: { json(): Promise<unknown> },
  code: string,
  message = "the body is not JSON",
): RequestBody<unknown> {
  return new RequestBody(async () => {
    try {
      return await req.json();
    } catch {
      throw new HearthError(message, { owner: "user", disposition: "give-up", code });
    }
  });
}

/** `input` itself, or what its `RequestBody` reads. */
export async function bodyOf<T>(input: T | RequestBody<T>): Promise<T> {
  return input instanceof RequestBody ? await input.read() : input;
}
