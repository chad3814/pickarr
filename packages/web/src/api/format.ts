import type { QualityTokens } from './client.ts';

export function formatQuality(quality: QualityTokens): string {
  const parts: string[] = [];
  if (quality.resolution !== undefined) parts.push(`${quality.resolution}p`);
  if (quality.source !== undefined) parts.push(quality.source);
  if (quality.videoCodec !== undefined) parts.push(quality.videoCodec);
  if (quality.releaseGroup !== undefined) parts.push(quality.releaseGroup);
  return parts.length === 0 ? 'unknown quality' : parts.join(' · ');
}

const UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(1)} ${UNITS[unit]}`;
}
