import { randomInt } from "node:crypto";

import bcrypt from "bcryptjs";

/* Recovery codes: how a forgotten password is reset without email.
 *
 * Shown once at sign-up (and again whenever a new one is made); only a bcrypt
 * hash is kept, so nobody -- the server included -- can read it back. Twelve
 * characters from an alphabet with nothing that looks like something else
 * (no 0/O, 1/I/L): sixty bits, which cannot be guessed. Using one replaces it.
 */

const ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // 31 characters
export const CODE_LENGTH = 12;

/** "K7F2-9QXM-4TBD". */
export function makeRecoveryCode(): string {
  const raw = Array.from({ length: CODE_LENGTH }, () => ALPHABET[randomInt(ALPHABET.length)]).join("");
  return raw.replace(/(.{4})(?=.)/g, "$1-");
}

/** What someone typed, as the 12 characters it stands for -- or null if it cannot be one. */
export function normaliseCode(input: string): string | null {
  const s = input.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return s.length === CODE_LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

export const hashRecoveryCode = (code: string) => bcrypt.hash(normaliseCode(code) ?? code, 10);

export async function checkRecoveryCode(input: string, hash: string | null | undefined): Promise<boolean> {
  const code = normaliseCode(input);
  /* Always spend the same time, so a wrong email and a wrong code look alike. */
  const target = hash || "$2a$10$invalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidinvalidi";
  const ok = await bcrypt.compare(code ?? "invalid", target);
  return ok && !!code && !!hash;
}
