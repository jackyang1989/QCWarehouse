import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { guard, hash } from "./common";

export function pepper() {
  const value = process.env.AUTH_OTP_PEPPER;
  guard(value && value.length >= 32, "AUTH_UNAVAILABLE", "Authentication configuration is incomplete.", 503);
  return value;
}

export function seal(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", Buffer.from(hash(pepper()), "hex"), iv);
  const data = Buffer.concat([cipher.update(value, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), data]);
}

export function unseal(value: Buffer) {
  guard(Buffer.isBuffer(value) && value.length >= 28, "SECRET_CORRUPT", "Encrypted secret payload is invalid.", 500);
  const decipher = createDecipheriv("aes-256-gcm", Buffer.from(hash(pepper()), "hex"), value.subarray(0, 12));
  decipher.setAuthTag(value.subarray(12, 28));
  return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString("utf8");
}

export { seal as encryptSecret, unseal as decryptSecret };
