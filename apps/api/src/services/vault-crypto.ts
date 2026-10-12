import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes } from "node:crypto";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const FORMAT = "v1";

/**
 * Encrypts PayPal Vault payment token ids at rest. The token id is a reusable
 * charge credential for this merchant, so it is never logged, returned to a
 * browser or stored in plaintext.
 */
export interface VaultCipher {
  /** AES-256-GCM ciphertext bound to the owning user (additional authenticated data). */
  encrypt(userId: string, tokenId: string): string;
  /** Throws when the value was not produced by this key for this user. */
  decrypt(userId: string, ciphertext: string): string;
  /** Keyed, non-reversible lookup value for matching verified webhooks. */
  hash(tokenId: string): string;
}

export class VaultCipherError extends Error {
  constructor() {
    super("The saved payment method could not be read.");
    this.name = "VaultCipherError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Accepts exactly 32 key bytes as 64 hex characters or canonical base64 /
 * base64url (for example `openssl rand -base64 32`). Anything else disables
 * vaulting instead of weakening the key.
 */
export function parseTokenEncryptionKey(value: string | undefined | null): Buffer | null {
  const text = value?.trim();
  if (!text) return null;
  if (/^[0-9a-fA-F]{64}$/u.test(text)) return Buffer.from(text, "hex");
  if (!/^[A-Za-z0-9+/_-]+={0,2}$/u.test(text)) return null;
  const normalized = text.replaceAll("-", "+").replaceAll("_", "/");
  const decoded = Buffer.from(normalized, "base64");
  if (decoded.length !== KEY_BYTES) return null;
  const canonical = decoded.toString("base64");
  if (canonical.replace(/=+$/u, "") !== normalized.replace(/=+$/u, "")) return null;
  return decoded;
}

function derive(key: Buffer, purpose: string) {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), `mandatepay:${purpose}`, KEY_BYTES));
}

function aad(userId: string) {
  return Buffer.from(`mandatepay:paypal-vault-token:${userId}`, "utf8");
}

export function createVaultCipher(value: string | undefined | null): VaultCipher | null {
  const key = parseTokenEncryptionKey(value);
  if (!key) return null;
  const encryptionKey = derive(key, "paypal-vault-encryption");
  const lookupKey = derive(key, "paypal-vault-lookup");
  return Object.freeze({
    encrypt(userId: string, tokenId: string) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv("aes-256-gcm", encryptionKey, iv);
      cipher.setAAD(aad(userId));
      const ciphertext = Buffer.concat([cipher.update(tokenId, "utf8"), cipher.final()]);
      return [
        FORMAT,
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(":");
    },
    decrypt(userId: string, value: string) {
      const [format, iv, tag, ciphertext, extra] = value.split(":");
      if (format !== FORMAT || !iv || !tag || !ciphertext || extra !== undefined) {
        throw new VaultCipherError();
      }
      try {
        const ivBytes = Buffer.from(iv, "base64url");
        const tagBytes = Buffer.from(tag, "base64url");
        if (ivBytes.length !== IV_BYTES || tagBytes.length !== TAG_BYTES) throw new Error();
        const decipher = createDecipheriv("aes-256-gcm", encryptionKey, ivBytes);
        decipher.setAAD(aad(userId));
        decipher.setAuthTag(tagBytes);
        return Buffer.concat([
          decipher.update(Buffer.from(ciphertext, "base64url")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        throw new VaultCipherError();
      }
    },
    hash(tokenId: string) {
      return createHmac("sha256", lookupKey).update(tokenId, "utf8").digest("hex");
    },
  });
}

/** Display-only masking: first character and domain (for example j***@example.com). */
export function maskEmail(value: string | null | undefined): string | null {
  if (!value) return null;
  const at = value.lastIndexOf("@");
  if (at < 1 || at === value.length - 1) return null;
  const domain = value.slice(at + 1);
  if (!/^[A-Za-z0-9.-]{1,253}$/u.test(domain)) return null;
  return `${value[0]}***@${domain}`.slice(0, 320);
}
