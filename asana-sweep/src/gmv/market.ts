/** "Kijimea IT", "TBC (DE)", "Vaseline - FR" → the two-letter market at the end of a shop name, or null. */
export function marketOfShopName(name: string): string | null {
  const m = name.trim().match(/(?:^|[\s(\-_])([A-Z]{2})\)?(?:\s*\[[^\]]*\])?$/);
  return m ? (m[1] === 'GB' ? 'UK' : m[1]) : null;
}
