import { hash, verify } from "@node-rs/argon2";

// argon2id at the library defaults (19 MiB, 2 passes, 1 lane), which are the
// OWASP recommended parameters. They are not spelled out here on purpose:
// pinning them in code means a future upgrade of the recommendation needs a
// code change, and the encoded hash already records the parameters it was made
// with, so verification of old hashes keeps working either way.
export function hashPassword(password: string): Promise<string> {
  return hash(password);
}

export async function verifyPassword(
  passwordHash: string,
  password: string
): Promise<boolean> {
  try {
    return await verify(passwordHash, password);
  } catch {
    // verify throws on a string that is not a valid argon2 hash rather than
    // returning false. Accounts carried over from the old Member table hold the
    // "!no-password-set" placeholder, so that path is reached on every login
    // attempt against one of them and has to be an ordinary failure, not a 500.
    return false;
  }
}
