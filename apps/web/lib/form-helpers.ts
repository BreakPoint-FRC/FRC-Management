/**
 * Turning form state into a request body.
 *
 * Every control in the app holds a string, because that is what an input gives
 * you. These are the three conversions needed on the way out, kept in one place
 * so no form invents a fourth.
 */

/**
 * An empty text box means "no value", not an empty string.
 *
 * The API distinguishes them: a nullable column set to "" is a description that
 * exists and is blank, which is not what someone who cleared the field meant.
 */
export function emptyToNull(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * An empty optional field is left out of the body entirely.
 *
 * On a PATCH this is the difference between "do not touch this" and "set it to
 * null" -- the services read `undefined` as the former.
 */
export function emptyToUndefined(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/**
 * A select whose empty option means "no group".
 *
 * Distinct from emptyToUndefined because a cross-group task and a task whose
 * group is simply unchanged are different requests.
 */
export function selectToNull(value: string): string | null {
  return value === "" ? null : value;
}
