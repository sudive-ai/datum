/**
 * Nominal branding for identifiers.
 *
 * Every identifier crossing a package boundary is a {@link Branded} value:
 * structurally it is its underlying primitive, but the phantom brand makes two
 * different ID types mutually non-assignable at compile time — a `SessionId`
 * can never be passed where a `TopCallId` is expected. The brand exists only
 * in the type system; at runtime a branded value *is* its primitive, so it
 * serializes, compares, and maps without wrappers.
 */

declare const brandMarker: unique symbol

/**
 * A value of `T` carrying the phantom brand `B`.
 *
 * @typeParam B — the brand name, e.g. `'SessionId'`.
 * @typeParam T — the underlying primitive; a string by default.
 */
export type Branded<B extends string, T = string> = T & {
  readonly [brandMarker]?: B
}

/**
 * Brand a string identifier.
 *
 * @param value — the raw string identifier.
 * @returns the same string, branded as `B`.
 */
export function brand<B extends string>(value: string): Branded<B> {
  return value as Branded<B>
}

/**
 * Brand a numeric identifier.
 *
 * @param value — the raw number.
 * @returns the same number, branded as `B` over `number`.
 */
export function brandNumber<B extends string>(value: number): Branded<B, number> {
  return value as Branded<B, number>
}
