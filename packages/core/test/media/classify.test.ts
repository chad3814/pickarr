import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageSize } from 'image-size';
import { classifyArtwork } from '../../src/media/classify.ts';

/** A minimal but valid PNG carrying the given dimensions in its IHDR. */
function png(width: number, height: number): Uint8Array {
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdrType = [0x49, 0x48, 0x44, 0x52];
  const ihdrData = new Uint8Array(13);
  const ihdrView = new DataView(ihdrData.buffer);
  ihdrView.setUint32(0, width, false);
  ihdrView.setUint32(4, height, false);
  ihdrData[8] = 8; // bit depth
  ihdrData[9] = 6; // color type: truecolor with alpha
  ihdrData[10] = 0; // compression
  ihdrData[11] = 0; // filter
  ihdrData[12] = 0; // interlace
  const lengthBytes = new Uint8Array(4);
  new DataView(lengthBytes.buffer).setUint32(0, ihdrData.length, false);
  // image-size never checks the CRC, so a zeroed trailer is fine here.
  const crc = new Uint8Array(4);
  return new Uint8Array([...signature, ...lengthBytes, ...ihdrType, ...ihdrData, ...crc]);
}

/** A minimal but valid baseline JPEG carrying the given dimensions in its SOF0 marker. */
function jpeg(width: number, height: number): Uint8Array {
  const bytes: number[] = [0xff, 0xd8]; // SOI
  const app0 = [0x4a, 0x46, 0x49, 0x46, 0x00, 1, 1, 0, 0, 1, 0, 1, 0, 0]; // "JFIF\0" + version/units/density/thumbnail
  const app0Length = app0.length + 2;
  bytes.push(0xff, 0xe0, (app0Length >> 8) & 0xff, app0Length & 0xff, ...app0);
  const sof = [
    8, // precision
    (height >> 8) & 0xff, height & 0xff,
    (width >> 8) & 0xff, width & 0xff,
    1, // number of components
    1, 0x11, 0, // component id, sampling factors, quantization table
  ];
  const sofLength = sof.length + 2;
  bytes.push(0xff, 0xc0, (sofLength >> 8) & 0xff, sofLength & 0xff, ...sof);
  bytes.push(0xff, 0xd9); // EOI
  return new Uint8Array(bytes);
}

/** A minimal but valid extended-format (VP8X) WebP carrying the given dimensions. */
function webp(width: number, height: number): Uint8Array {
  const widthLess1 = width - 1;
  const heightLess1 = height - 1;
  const vp8xPayload = new Uint8Array(10);
  // byte 0 is the flags byte, bytes 1-3 are reserved; both stay zero.
  vp8xPayload[4] = widthLess1 & 0xff;
  vp8xPayload[5] = (widthLess1 >> 8) & 0xff;
  vp8xPayload[6] = (widthLess1 >> 16) & 0xff;
  vp8xPayload[7] = heightLess1 & 0xff;
  vp8xPayload[8] = (heightLess1 >> 8) & 0xff;
  vp8xPayload[9] = (heightLess1 >> 16) & 0xff;

  const vp8xChunk = new Uint8Array(8 + vp8xPayload.length);
  vp8xChunk.set([0x56, 0x50, 0x38, 0x58], 0); // "VP8X"
  new DataView(vp8xChunk.buffer).setUint32(4, vp8xPayload.length, true);
  vp8xChunk.set(vp8xPayload, 8);

  const riffPayload = new Uint8Array(4 + vp8xChunk.length);
  riffPayload.set([0x57, 0x45, 0x42, 0x50], 0); // "WEBP"
  riffPayload.set(vp8xChunk, 4);

  const out = new Uint8Array(8 + riffPayload.length);
  out.set([0x52, 0x49, 0x46, 0x46], 0); // "RIFF"
  new DataView(out.buffer).setUint32(4, riffPayload.length, true);
  out.set(riffPayload, 8);
  return out;
}

test('a landscape image is a background', () => {
  const bytes = png(1279, 719);
  // Round-trip guard: a fixture image-size cannot read would make the
  // classification assertion below meaningless.
  assert.deepEqual(imageSize(bytes), { width: 1279, height: 719, type: 'png' });
  assert.equal(classifyArtwork(bytes), 'background');
});

test('a portrait image is a poster', () => {
  assert.equal(classifyArtwork(png(800, 1200)), 'poster');
});

test('a square image is a poster, because the 2:3 slot crops it least', () => {
  assert.equal(classifyArtwork(png(500, 500)), 'poster');
});

test('bytes that are not an image classify as nothing rather than throwing', () => {
  assert.equal(classifyArtwork(new Uint8Array([1, 2, 3, 4])), null);
});

test('a landscape JPEG is a background', () => {
  const bytes = jpeg(1279, 719);
  assert.deepEqual(imageSize(bytes), { width: 1279, height: 719, type: 'jpg' });
  assert.equal(classifyArtwork(bytes), 'background');
});

test('a portrait JPEG is a poster', () => {
  const bytes = jpeg(800, 1200);
  assert.deepEqual(imageSize(bytes), { width: 800, height: 1200, type: 'jpg' });
  assert.equal(classifyArtwork(bytes), 'poster');
});

test('a landscape WebP is a background', () => {
  const bytes = webp(1279, 719);
  assert.deepEqual(imageSize(bytes), { width: 1279, height: 719, type: 'webp' });
  assert.equal(classifyArtwork(bytes), 'background');
});

test('a portrait WebP is a poster', () => {
  const bytes = webp(800, 1200);
  assert.deepEqual(imageSize(bytes), { width: 800, height: 1200, type: 'webp' });
  assert.equal(classifyArtwork(bytes), 'poster');
});
