/** Shared field shapes for protocol schemas. Lengths count code points, so the emitted JSON Schema is exact. */
import { Schema } from "effect"

export const Text = (min: number, max?: number) =>
  max === undefined
    ? Schema.String.check(Schema.isMinCodePoints(min))
    : Schema.String.check(Schema.isMinCodePoints(min), Schema.isMaxCodePoints(max))

export const NonEmptyList = <S extends Schema.Top>(item: S) =>
  Schema.Array(item).check(Schema.isMinLength(1))

export const normalize = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, " ")
