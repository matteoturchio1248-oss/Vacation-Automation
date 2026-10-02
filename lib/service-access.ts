import { runtimeEnv } from "./database";
import { sha256 } from "./security";

// Missing or short configuration locks setup/jobs rather than opening access.
export async function secretMatches(expected: string | undefined, supplied: unknown) {
  if (!expected || expected.length < 32 || typeof supplied !== "string" || supplied.length > 256) return false;
  const [left, right] = await Promise.all([sha256(expected), sha256(supplied)]);
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  return difference === 0;
}

export function jobAuthorized(request: Request) {
  const header = request.headers.get("authorization");
  return secretMatches(runtimeEnv().JOBS_SECRET, header?.startsWith("Bearer ") ? header.slice(7) : undefined);
}
