/** POSIX single-quote a value so a shell treats it as one literal argv entry. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
