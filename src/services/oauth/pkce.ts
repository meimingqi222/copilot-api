import { createHash, randomBytes } from "node:crypto"

export interface PkceCodes {
  codeVerifier: string
  codeChallenge: string
}

function toBase64Url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "")
}

export function generateOAuthState(): string {
  return randomBytes(32).toString("hex")
}

export function generatePkceCodes(): PkceCodes {
  const codeVerifier = toBase64Url(randomBytes(96))
  const codeChallenge = toBase64Url(
    createHash("sha256").update(codeVerifier).digest(),
  )
  return { codeVerifier, codeChallenge }
}
