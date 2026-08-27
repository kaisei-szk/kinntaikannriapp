function escapeCsvField(value) {
  const str = value === null || value === undefined ? '' : String(value);
  if (/[",\n\r]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export function toCsv(rows, columns) {
  const header = columns.map((c) => escapeCsvField(c.label)).join(',');
  const lines = rows.map((row) =>
    columns.map((c) => escapeCsvField(row[c.key])).join(',')
  );
  // Prepend a UTF-8 BOM so Excel on Windows/Mac opens Japanese text correctly.
  return '﻿' + [header, ...lines].join('\r\n') + '\r\n';
}
