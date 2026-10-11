export const packageName: string = "@penguin/issues";

export { canonicalBytes, canonicalJson } from "./canonical.ts";
export {
  fromBase64Url,
  generateSigningKeyPair,
  importPrivateKey,
  importPublicKey,
  signOperation,
  signingBytes,
  toBase64Url,
  verifyOperation,
} from "./signature.ts";
