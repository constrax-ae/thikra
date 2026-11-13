// Cutting a message down to a title or a quote.
//
// Every one of these was a bare `slice(0, 60)`, which cuts wherever the 60th character
// happens to fall — usually inside a word, so the family archive was full of entries
// reading "…congratul". A keepsake page cannot look like that.
//
// Arabic matters here as much as English: it has no spaces inside a word either, but its
// words are longer on average, so a blind cut lands mid-word more often, not less.

/** Characters we are willing to end a line on, in either script. */
const SENTENCE_END = /[.!?؟۔]\s/;

/**
 * Shorten `text` to at most `max` characters, ending on a whole word.
 *
 * Prefers to stop at the end of a sentence when one finishes in the last third, since a
 * complete sentence reads as a title rather than as a fragment. It has to fill at least
 * 40% of the budget, so a stray "Ok." at the start never becomes the whole title. Otherwise it falls back to
 * the last word boundary. The ellipsis is only added when something was actually dropped.
 */
export function excerpt(text: string, max = 60): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean.length <= max) return clean;

  const window = clean.slice(0, max + 1);

  // A sentence that ends late in the window makes the cleanest title.
  const sentence = [...window.matchAll(new RegExp(SENTENCE_END, 'g'))].pop();
  if (sentence && sentence.index >= max * 0.4) return clean.slice(0, sentence.index + 1).trim();

  // Otherwise step back to the last space, so no word is left half-written.
  const space = window.lastIndexOf(' ');
  // A single word longer than the limit has no boundary to find; cut it rather than
  // return the whole thing, but keep it rare by cutting at the limit itself.
  const cut = space > max * 0.4 ? space : max;
  return clean.slice(0, cut).replace(/[\s،,؛;:-]+$/, '') + '…';
}
