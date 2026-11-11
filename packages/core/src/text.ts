// Untrusted text, folded before any built-in pattern reads it. An invoice can hide "ignore previous instructions"
// from a plain regex with characters a person never sees: zero-width joiners, soft hyphens, full-width letters, or a
// Cyrillic letter that looks like a Latin one. The fold only ever feeds the patterns and the invoice hash. The text the
// owner sees, and the text the private AI reads, is never changed.

/** Letters from other alphabets that print like Latin ones. Lower case only: the fold lowercases first. */
const CONFUSABLE_LETTERS: Record<string, string> = {
  а: "a", е: "e", о: "o", р: "p", с: "c", у: "y", х: "x", і: "i", ѕ: "s", ј: "j", һ: "h", ԁ: "d", ԛ: "q", ԝ: "w", ѵ: "v", ʏ: "y",
  ο: "o", α: "a", ν: "v", ι: "i", κ: "k", τ: "t", ϲ: "c",
};

/**
 * What the patterns read: compatibility-normalised (so full-width and ligature forms become plain letters), with
 * invisible format characters removed, and look-alike letters from other alphabets mapped to Latin ones.
 */
export function foldText(text: string): string {
  const visible = text.normalize("NFKC").replace(/\p{Cf}/gu, "");
  return [...visible.toLowerCase()].map((character) => CONFUSABLE_LETTERS[character] ?? character).join("");
}
