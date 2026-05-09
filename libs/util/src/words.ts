/** https://stackoverflow.com/questions/13627308/add-st-nd-rd-and-th-ordinal-suffix-to-a-number */
export function getNumberWithOrdinal(n: number | string) {
  const num = typeof n === 'string' ? Number.parseInt(n) : n;
  const s = ['th', 'st', 'nd', 'rd'],
    v = num % 100;
  return num.toString() + (s[(v - 20) % 10] || s[v] || s[0]);
}

export function cleanSlackLink(text: string): string {
  const match = text.match(/<[^|]+\|([^>]+)>/);
  if (match && match[1]) {
    return match[1];
  }
  return text;
}
