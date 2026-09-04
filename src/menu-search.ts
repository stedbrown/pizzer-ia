/**
 * Il cliente non nomina i prodotti come sono scritti a menu: dice "una pizza margherita",
 * non "Margherita". Una ricerca sulla frase intera non trova nulla e l'agente rischia di
 * rispondere che il prodotto non c'è, oltre a sprecare un giro di ricerca.
 */
const FILLER = new Set([
  'pizza', 'pizze', 'una', 'uno', 'del', 'della', 'delle', 'dei', 'con', 'senza', 'per',
  'vorrei', 'volevo', 'prendo', 'prendere', 'mettere', 'anche', 'poi', 'che', 'cosa', 'avete'
]);

/** Termini utili della richiesta: se restano solo parole di riempimento si cerca la frase così com'è. */
export function menuSearchTerms(query: string): string[] {
  const raw = query.trim().toLocaleLowerCase('it-CH');
  if (!raw) return [];
  const words = raw.split(/[^\p{L}\p{N}]+/u).filter((word) => word.length >= 3);
  const meaningful = words.filter((word) => !FILLER.has(word));
  const terms = meaningful.length ? meaningful : words;
  return terms.length ? terms.slice(0, 5) : [raw];
}

export function matchesMenuQuery(item: { name: string; description?: string }, query: string) {
  const terms = menuSearchTerms(query);
  if (!terms.length) return true;
  const haystack = `${item.name} ${item.description ?? ''}`.toLocaleLowerCase('it-CH');
  return terms.some((term) => haystack.includes(term));
}
