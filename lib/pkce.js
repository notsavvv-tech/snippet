import { createHash, randomBytes } from "crypto";

function base64URLEncode(buf) {
  return Buffer.from(buf)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=/g, "");
}

/** Random verifier (43+ chars) for PKCE */
export function generateCodeVerifier() {
  return base64URLEncode(randomBytes(32));
}

/** S256 challenge = BASE64URL(SHA256(verifier)) */
export function generateCodeChallenge(verifier) {
  return base64URLEncode(createHash("sha256").update(verifier).digest());
}
