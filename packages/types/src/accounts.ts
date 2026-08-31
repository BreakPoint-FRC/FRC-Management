import { z } from "zod";

import { accountRoleSchema } from "./roles";

// Minimum that is worth enforcing rather than theatre. Length does more for a
// password than a character-class rule, which mostly teaches people to end
// everything with "1!".
export const passwordSchema = z.string().min(10, "Sifre en az 10 karakter olmali").max(200);

export const emailSchema = z.string().email("Gecerli bir e-posta adresi girin");

export const accountSchema = z.object({
  id: z.string(),
  // null only for platform system admins, who belong to no team on purpose.
  teamId: z.string().nullable(),
  email: emailSchema,
  fullName: z.string().min(1),
  isActive: z.boolean(),
  // True while the account is still on a password an admin generated for it.
  // The API lets such an account authenticate and change its password and
  // refuses everything else -- see requirePasswordChange in plugins/auth.ts.
  mustChangePassword: z.boolean(),
  archivedAt: z.coerce.date().nullable(),
  roles: z.array(accountRoleSchema),
});

// isActive and archivedAt answer different questions and both are kept:
// isActive   -- may they sign in right now (suspension)
// archivedAt -- have they left the team (roster history)
// The API exposes both; DELETE /accounts/:id sets archivedAt and clears
// isActive, because someone who has left should not also still be able to log
// in.
export type Account = z.infer<typeof accountSchema>;

/**
 * A password to hand to someone who has none yet.
 *
 * There is no mail sending in this project, so a generated password is read off
 * a screen once and typed in. That is why it avoids the characters people
 * misread aloud -- 0/O, 1/l/I -- and why every account created with one is
 * flagged mustChangePassword: it is a way in, not a credential.
 *
 * Uses the platform CSPRNG. Math.random is not one and must never be used here.
 */
export function generateTemporaryPassword(randomBytes: (size: number) => Uint8Array): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789";
  const length = 16;
  // Rejection sampling: taking the raw byte modulo the alphabet length would
  // make the first few characters marginally likelier than the rest.
  const limit = Math.floor(256 / alphabet.length) * alphabet.length;
  let out = "";
  while (out.length < length) {
    for (const byte of randomBytes(length)) {
      if (byte >= limit) continue;
      out += alphabet[byte % alphabet.length];
      if (out.length === length) break;
    }
  }
  return out;
}
