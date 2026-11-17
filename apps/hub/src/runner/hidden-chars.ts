/**
 * Hidden characters on the approval card (#165, decision 0048): a command can
 * read as harmless when it holds bidi controls (a right-to-left override
 * reverses what the eye sees), zero-width characters or other control
 * characters. The card shows each as a visible `⟨U+XXXX⟩` instead, after
 * redaction (so a secret holding one is still redacted whole first). Tab and
 * newline stay: a command may use them and the card wraps them.
 */

const HIDDEN =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point
  /[\u0000-\u0008\u000B-\u001F\u007F-\u009F؜​-‏‪-‮⁠⁦-⁩﻿]/g;

/** `text` with every hidden character written out as `⟨U+XXXX⟩`. */
export function escapeHidden(text: string): string {
  return text.replace(HIDDEN, (ch) => {
    const hex = (ch.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0");
    return `⟨U+${hex}⟩`;
  });
}

/** Whether `text` holds a hidden character (before escaping). */
export function hasHidden(text: string): boolean {
  HIDDEN.lastIndex = 0;
  return HIDDEN.test(text);
}

/** Whether `text` holds an escape this module wrote (what the stored card text keeps). */
export function hasHiddenEscape(text: string): boolean {
  return /⟨U\+[0-9A-F]{4}⟩/.test(text);
}
