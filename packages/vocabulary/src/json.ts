/**
 * JSON value vocabulary for anything that crosses the log boundary.
 *
 * Every persisted session-event payload field is a {@link JsonValue}: the log
 * must stay JSON-serializable byte-for-byte, so the fixed language forbids
 * Maps, Sets, class instances, and functions in persisted positions.
 */

/** A JSON scalar: `null`, boolean, number, or string. */
export type JsonPrimitive = null | boolean | number | string

/** A JSON object. Keys are strings; values are JSON values. */
export interface JsonRecord {
  readonly [key: string]: JsonValue
}

/** A JSON array. */
export type JsonArray = readonly JsonValue[]

/** Anything that may be persisted to the session log. */
export type JsonValue = JsonPrimitive | JsonRecord | JsonArray
