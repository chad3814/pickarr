export type SqlValue = string | number | bigint | null | Uint8Array;
export type SqlRow = Record<string, SqlValue>;

export function num(row: SqlRow, key: string): number {
  const value = row[key];
  if (typeof value === 'number') return value;
  if (typeof value === 'bigint') return Number(value);
  throw new Error(`Column ${key} is not numeric`);
}

export function maybeNum(row: SqlRow, key: string): number | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return num(row, key);
}

export function str(row: SqlRow, key: string): string {
  const value = row[key];
  if (typeof value === 'string') return value;
  throw new Error(`Column ${key} is not a string`);
}

export function maybeStr(row: SqlRow, key: string): string | null {
  const value = row[key];
  if (value === null || value === undefined) return null;
  return str(row, key);
}
