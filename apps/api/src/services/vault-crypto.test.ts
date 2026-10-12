import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  VaultCipherError,
  createVaultCipher,
  maskEmail,
  parseTokenEncryptionKey,
} from "./vault-crypto.js";

const base64Key = randomBytes(32).toString("base64");

describe("TOKEN_ENCRYPTION_KEY validation", () => {
  it("accepts exactly 32 bytes as hex, base64 or base64url", () => {
    const bytes = randomBytes(32);
    expect(parseTokenEncryptionKey(bytes.toString("hex"))?.equals(bytes)).toBe(true);
    expect(parseTokenEncryptionKey(bytes.toString("base64"))?.equals(bytes)).toBe(true);
    expect(parseTokenEncryptionKey(bytes.toString("base64url"))?.equals(bytes)).toBe(true);
  });

  it("refuses missing, short, long and non-canonical keys", () => {
    expect(parseTokenEncryptionKey(undefined)).toBeNull();
    expect(parseTokenEncryptionKey("")).toBeNull();
    expect(parseTokenEncryptionKey("   ")).toBeNull();
    expect(parseTokenEncryptionKey(randomBytes(16).toString("base64"))).toBeNull();
    expect(parseTokenEncryptionKey(randomBytes(48).toString("base64"))).toBeNull();
    expect(parseTokenEncryptionKey(randomBytes(31).toString("hex"))).toBeNull();
    expect(parseTokenEncryptionKey("not a key at all, just a passphrase!!")).toBeNull();
    expect(createVaultCipher("short")).toBeNull();
  });
});

describe("vault token cipher", () => {
  it("round-trips a token id without storing it in plaintext", () => {
    const cipher = createVaultCipher(base64Key);
    expect(cipher).not.toBeNull();
    const encrypted = cipher!.encrypt("user-1", "jwgvx42");
    expect(encrypted).not.toContain("jwgvx42");
    expect(encrypted.startsWith("v1:")).toBe(true);
    expect(cipher!.decrypt("user-1", encrypted)).toBe("jwgvx42");
    // A fresh IV each time.
    expect(cipher!.encrypt("user-1", "jwgvx42")).not.toBe(encrypted);
  });

  it("binds ciphertext to its owner and key, and detects tampering", () => {
    const cipher = createVaultCipher(base64Key)!;
    const other = createVaultCipher(randomBytes(32).toString("hex"))!;
    const encrypted = cipher.encrypt("user-1", "jwgvx42");
    expect(() => cipher.decrypt("user-2", encrypted)).toThrow(VaultCipherError);
    expect(() => other.decrypt("user-1", encrypted)).toThrow(VaultCipherError);
    const parts = encrypted.split(":");
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => cipher.decrypt("user-1", parts.join(":"))).toThrow(VaultCipherError);
    expect(() => cipher.decrypt("user-1", "plaintext-token")).toThrow(VaultCipherError);
  });

  it("derives a stable keyed lookup hash that differs per key", () => {
    const cipher = createVaultCipher(base64Key)!;
    const other = createVaultCipher(randomBytes(32).toString("base64"))!;
    expect(cipher.hash("jwgvx42")).toMatch(/^[0-9a-f]{64}$/u);
    expect(cipher.hash("jwgvx42")).toBe(cipher.hash("jwgvx42"));
    expect(cipher.hash("jwgvx42")).not.toBe(other.hash("jwgvx42"));
  });
});

describe("payer email masking", () => {
  it("keeps only the first character and the domain", () => {
    expect(maskEmail("buyer@example.com")).toBe("b***@example.com");
    expect(maskEmail(null)).toBeNull();
    expect(maskEmail("@example.com")).toBeNull();
    expect(maskEmail("buyer@")).toBeNull();
  });
});
