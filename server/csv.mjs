function escapeCsvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

// ヘッダー行 + データ行。BOM も末尾改行も付けないので、複数ブロックの連結に使える。
export function toCsvBody(rows, columns) {
  const header = columns.map((c) => escapeCsvField(c.label)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => escapeCsvField(row[c.key])).join(',')
  );
  return [header, ...lines].join('\r\n');
}

export function csvLine(values) {
  return values.map(escapeCsvField).join(',');
}

export function toCsv(rows, columns) {
  // Prepend a UTF-8 BOM so Excel on Windows/Mac opens Japanese text correctly.
  return '﻿' + toCsvBody(rows, columns) + '\r\n';
}
