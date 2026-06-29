/**
 * Make Prisma payloads JSON-safe.
 *
 * `BigInt` has no default JSON representation (JSON.stringify throws), so we teach it to serialise as
 * a string. Prisma's `Decimal` already serialises to its string form via its own `toJSON`. Importing
 * this module once (at app boot) installs the BigInt behaviour process-wide.
 */
declare global {
  interface BigInt {
    toJSON(): string;
  }
}

BigInt.prototype.toJSON = function toJSON(this: bigint): string {
  return this.toString();
};

export {};
