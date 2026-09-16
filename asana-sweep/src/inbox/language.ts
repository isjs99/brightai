// Pure helpers: language guessing for replies. No Node-only imports.

const MARKET_LANGUAGE: Record<string, string> = { DE: 'de', AT: 'de', CH: 'de', UK: 'en', GB: 'en', IE: 'en', US: 'en', FR: 'fr', BE: 'fr', IT: 'it', ES: 'es', NL: 'nl', PL: 'pl', PT: 'pt', SE: 'sv' };

const HINTS: Record<string, RegExp> = {
  de: /\b(ich|nicht|und|bitte|danke|bestellung|lieferung|wann|wo ist|kann ich|hallo|guten tag|rücksendung|paket)\b/i,
  fr: /\b(je|pas|bonjour|merci|commande|livraison|colis|quand|remboursement|s'il vous plaît|svp)\b/i,
  it: /\b(non|ciao|grazie|ordine|consegna|pacco|quando|rimborso|salve|buongiorno)\b/i,
  es: /\b(no|hola|gracias|pedido|envío|envio|paquete|cuándo|cuando|reembolso|buenos días)\b/i,
  nl: /\b(ik|niet|hallo|bedankt|bestelling|levering|pakket|wanneer|retour)\b/i,
  pl: /\b(nie|dzień dobry|dziękuję|zamówienie|przesyłka|paczka|kiedy|zwrot)\b/i,
  en: /\b(the|please|thanks|thank you|order|delivery|parcel|when|refund|hello|hi)\b/i,
};

/** Guess the language of the other side: their words first, then the shop's market, then English. */
export function guessLanguage(text: string | null | undefined, market: string | null | undefined, override?: string | null): string {
  if (override) return override;
  if (text && text.trim().length >= 12) {
    let best: { lang: string; hits: number } | null = null;
    for (const [lang, re] of Object.entries(HINTS)) {
      const hits = (text.match(new RegExp(re.source, 'gi')) ?? []).length;
      if (hits && (!best || hits > best.hits)) best = { lang, hits };
    }
    if (best && best.hits >= 2) return best.lang;
  }
  return MARKET_LANGUAGE[(market ?? '').toUpperCase()] ?? 'en';
}

export const LANGUAGE_NAMES: Record<string, string> = { '*': 'All languages', en: 'English', de: 'German', fr: 'French', it: 'Italian', es: 'Spanish', nl: 'Dutch', pl: 'Polish', pt: 'Portuguese', sv: 'Swedish' };
