/**
 * Hidden characters on the approval card (#165, decision 0048): a command can
 * read as harmless when it holds bidi controls (a right-to-left override
 * reverses what the eye sees), zero-width characters or other control
 * characters. The card shows each as a visible `⟨U+XXXX⟩` instead, after
 * redaction (so a secret holding one is still redacted whole first). What is
 * escaped is chosen by Unicode property, not by a list (#167): bash splits words
 * only at ASCII space, tab and newline, so every other space-like character
 * (NBSP, U+3000, U+2028, the Hangul filler U+3164, ...) is part of a word and
 * must not read as a gap; the same holds for every default-ignorable code
 * point (soft hyphen, variation selectors, tag characters, ...), format
 * characters (Cf) and C0/C1 controls. ASCII space, tab and newline stay.
 */

const HIDDEN = /[\p{White_Space}\p{Default_Ignorable_Code_Point}\p{Cf}\p{Zl}\p{Zp}\p{Cc}]/gu;

/** `text` with every hidden character written out as `⟨U+XXXX⟩` (one per code point). */
export function escapeHidden(text: string): string {
  return text.replace(HIDDEN, (ch) => {
    if (ch === " " || ch === "\t" || ch === "\n") return ch;
    const hex = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    return `⟨U+${hex}⟩`;
  });
}

/** Whether `text` holds a hidden character (before escaping). */
export function hasHidden(text: string): boolean {
  return escapeHidden(text) !== text;
}

/** Whether `text` holds an escape this module wrote (what the stored card text keeps). */
export function hasHiddenEscape(text: string): boolean {
  return /⟨U\+[0-9A-F]{4,6}⟩/.test(text);
}
