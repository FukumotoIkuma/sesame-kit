// Ambient typing for the untyped `node-aes-cmac` CJS module (no @types package exists).
// Only the `aesCmac` surface this codebase uses is declared.
declare module "node-aes-cmac" {
  import { Buffer } from "node:buffer";
  /**
   * AES-CMAC (RFC 4493). With `returnAsBuffer: true` returns a Buffer, otherwise a hex string.
   */
  export function aesCmac(
    key: Buffer | Uint8Array,
    message: Buffer | Uint8Array,
    options: { returnAsBuffer: true },
  ): Buffer;
  export function aesCmac(
    key: Buffer | Uint8Array,
    message: Buffer | Uint8Array,
    options?: { returnAsBuffer?: false },
  ): string;
}
