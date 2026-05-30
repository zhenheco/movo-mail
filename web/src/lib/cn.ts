/** Tiny className joiner (no clsx dep): drops falsy values, joins with space. */
export function cn(...values: Array<string | false | null | undefined>): string {
  return values.filter((v): v is string => Boolean(v)).join(" ");
}
