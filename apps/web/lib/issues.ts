import type { ApiError } from "./api-client";

/**
 * Finds the validation message for one field.
 *
 * The API answers a bad payload with Zod's issue list, each pathed at the entry
 * that broke the rule -- `["roles", 1]` for the second role in a list,
 * `["dueDate"]` for a plain field. Showing that message under the input it
 * belongs to is the whole reason the API bothers to send the path.
 *
 * Matching is by prefix, so `issueFor(error, "roles", 1)` also picks up an
 * issue pathed at `["roles", 1, "groupId"]` -- a row-level control can surface
 * a complaint about one of its own sub-fields without knowing its shape.
 */
export function issueFor(
  error: ApiError | null | undefined,
  ...path: Array<string | number>
): string | undefined {
  if (!error?.issues) return undefined;

  return error.issues.find(
    (issue) =>
      path.length <= issue.path.length &&
      path.every((segment, index) => issue.path[index] === segment)
  )?.message;
}

/**
 * Whether the error is worth showing whole at the top of a form.
 *
 * A 400 with field-level issues is already rendered beside the inputs, so
 * repeating it in a banner is noise. Everything else -- a 403 explaining which
 * permission is missing, a 409 explaining why a role cannot be deleted -- has
 * nowhere else to go.
 */
export function isFormLevel(error: ApiError | null | undefined): boolean {
  if (!error) return false;
  return !error.issues || error.issues.length === 0;
}
