/**
 * A minimal but genuinely valid GIF: `image-size` reads width and height
 * straight out of the logical screen descriptor, so this needs no CRCs the
 * way a PNG would. Shared rather than copied because three test files had
 * byte-identical versions of it, and a fixture that must be right in three
 * places is a fixture that will eventually be right in two.
 */
export function gifBytes(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(13);
  bytes.set(new TextEncoder().encode('GIF89a'), 0);
  bytes[6] = width & 0xff;
  bytes[7] = (width >> 8) & 0xff;
  bytes[8] = height & 0xff;
  bytes[9] = (height >> 8) & 0xff;
  return bytes;
}
