/** Backtick-quote a Timeplus identifier; reject anything not a plain name. */
export function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new TypeError(`Timeplus identifier "${name}" must match [A-Za-z_][A-Za-z0-9_]*`)
  }
  return `\`${name}\``
}
