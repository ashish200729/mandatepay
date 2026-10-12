import { calculateJwkThumbprint, exportJWK, generateKeyPair } from "jose";

/*
 * Prints a new EC P-256 private JWK for MANDATE_SIGNING_KEY to stdout (one JSON
 * line, nothing else) and the matching public JWK with its RFC 7638 kid to
 * stderr. Store the private JWK only in a secret store or an ignored .env file.
 * When rotating, add the old key's public JWK to MANDATE_SIGNING_PREVIOUS_JWKS
 * so credentials it signed keep verifying.
 */
const { privateKey } = await generateKeyPair("ES256", { extractable: true });
const jwk = await exportJWK(privateKey);
const publicJwk = { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } as const;
const kid = await calculateJwkThumbprint(publicJwk, "sha256");

process.stdout.write(
  `${JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y, d: jwk.d })}\n`,
);
process.stderr.write(
  `kid ${kid}\npublic JWK (safe to share; use in MANDATE_SIGNING_PREVIOUS_JWKS after rotation):\n${JSON.stringify({ ...publicJwk, kid, alg: "ES256", use: "sig" })}\n`,
);
