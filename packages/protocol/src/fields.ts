/**
 * Hand-written field guards used by the decoder (docs/DECISIONS.md, 0002).
 *
 * A failed guard throws `FieldError`. Only `decodeFrame` calls these and it
 * catches `FieldError` at its boundary, so no caller of the package sees a
 * throw: it gets a typed `DecodeError` instead.
 */

import type { JsonObject, JsonValue } from "./frames";

/** Longest id (box, boot, session, turn, request, rpc, holder). */
export const MAX_ID_LENGTH = 256;
/** Longest credential. */
export const MAX_CREDENTIAL_LENGTH = 4096;
/** Longest free-text field (messages, turn input, file paths). */
export const MAX_TEXT_LENGTH = 1_000_000;
/** Most arrays and objects nested inside each other in an opaque JSON payload. */
export const MAX_JSON_DEPTH = 64;
export const MAX_U32 = 0xffff_ffff;

export class FieldError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = "FieldError";
  }
}

export type Obj = Readonly<Record<string, unknown>>;

export function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Reads typed fields from one decoded JSON object, failing with the field's path. */
export class Fields {
  constructor(
    private readonly obj: Obj,
    private readonly prefix = "",
  ) {}

  path(key: string): string {
    return this.prefix === "" ? key : `${this.prefix}.${key}`;
  }

  has(key: string): boolean {
    return Object.hasOwn(this.obj, key) && this.obj[key] !== undefined;
  }

  raw(key: string): unknown {
    return Object.hasOwn(this.obj, key) ? this.obj[key] : undefined;
  }

  fail(key: string, message: string): never {
    throw new FieldError(this.path(key), message);
  }

  string(key: string, max = MAX_TEXT_LENGTH, allowEmpty = true): string {
    const value = this.raw(key);
    if (typeof value !== "string") this.fail(key, "expected a string");
    if (!allowEmpty && value.length === 0) this.fail(key, "must not be empty");
    if (value.length > max) this.fail(key, `longer than ${max} characters`);
    return value;
  }

  /** A non-empty identifier without whitespace or control characters. */
  id(key: string): string {
    const value = this.string(key, MAX_ID_LENGTH, false);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting control characters is the point
    if (/[\s\u0000-\u001f\u007f]/.test(value)) {
      this.fail(key, "must not contain whitespace or control characters");
    }
    return value;
  }

  int(key: string, min: number, max: number = Number.MAX_SAFE_INTEGER): number {
    const value = this.raw(key);
    if (typeof value !== "number" || !Number.isSafeInteger(value)) {
      this.fail(key, "expected an integer");
    }
    if (value < min || value > max) this.fail(key, `must be between ${min} and ${max}`);
    return value;
  }

  bool(key: string): boolean {
    const value = this.raw(key);
    if (typeof value !== "boolean") this.fail(key, "expected a boolean");
    return value;
  }

  oneOf<const T extends string>(key: string, values: readonly T[]): T {
    const value = this.raw(key);
    if (typeof value !== "string" || !(values as readonly string[]).includes(value)) {
      this.fail(key, `expected one of ${values.join(", ")}`);
    }
    return value as T;
  }

  object(key: string): Fields {
    const value = this.raw(key);
    if (!isObj(value)) this.fail(key, "expected an object");
    return new Fields(value, this.path(key));
  }

  json(key: string): JsonValue {
    if (!Object.hasOwn(this.obj, key)) this.fail(key, "missing");
    return checkJson(this.obj[key], this.path(key), 0);
  }

  jsonObject(key: string): JsonObject {
    const value = this.json(key);
    if (!isObj(value)) this.fail(key, "expected an object");
    return value as JsonObject;
  }

  /** Fails when the key is present; used for fields that only belong to another variant. */
  absent(key: string, why: string): void {
    if (this.has(key)) this.fail(key, why);
  }
}

/**
 * Checks and copies an opaque JSON value. `depth` counts the arrays and objects
 * that enclose `value`, so a payload may nest at most `MAX_JSON_DEPTH`
 * containers; scalars never count as a level.
 */
function checkJson(value: unknown, path: string, depth: number): JsonValue {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new FieldError(path, "expected a finite number");
    return value;
  }
  if (!Array.isArray(value) && !isObj(value)) throw new FieldError(path, "expected a JSON value");
  if (depth + 1 > MAX_JSON_DEPTH) {
    throw new FieldError(path, `nested deeper than ${MAX_JSON_DEPTH} levels`);
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => checkJson(item, `${path}[${index}]`, depth + 1));
  }
  // `fromEntries` defines own properties, so a `__proto__` key stays plain data.
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, checkJson(item, `${path}.${key}`, depth + 1)]),
  );
}
