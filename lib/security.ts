const encoder = new TextEncoder();

function bytesToBase64(bytes: Uint8Array) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function base64ToBytes(value: string) {
  const binary = atob(value);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(bytes = 32) {
  const value = new Uint8Array(bytes);
  crypto.getRandomValues(value);
  return bytesToBase64(value).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

export async function sha256(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(value));
  return bytesToBase64(new Uint8Array(digest));
}

const CURRENT_PBKDF2_ITERATIONS = 75_000;
const LEGACY_PBKDF2_ITERATIONS = 180_000;

export async function hashPassword(password: string, existingSalt?: string, iterations = CURRENT_PBKDF2_ITERATIONS) {
  const salt = existingSalt ? base64ToBytes(existingSalt) : crypto.getRandomValues(new Uint8Array(16));
  const material = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const derived = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    material,
    256,
  );
  return { hash: `pbkdf2-sha256$${iterations}$${bytesToBase64(new Uint8Array(derived))}`, salt: bytesToBase64(salt) };
}

export async function verifyPassword(password: string, salt: string, expectedHash: string) {
  const versioned = expectedHash.match(/^pbkdf2-sha256\$(\d+)\$(.+)$/);
  const iterations = versioned ? Number(versioned[1]) : LEGACY_PBKDF2_ITERATIONS;
  const storedDigest = versioned ? versioned[2] : expectedHash;
  const { hash } = await hashPassword(password, salt, iterations);
  const calculatedDigest = hash.split("$").at(-1) ?? "";
  const actual = encoder.encode(calculatedDigest);
  const expected = encoder.encode(storedDigest);
  if (actual.length !== expected.length) return false;
  let difference = 0;
  for (let index = 0; index < actual.length; index += 1) difference |= actual[index] ^ expected[index];
  return difference === 0;
}

export function passwordIsStrong(password: string) {
  return password.length >= 6 && /[A-Za-z]/.test(password) && /\d/.test(password);
}
