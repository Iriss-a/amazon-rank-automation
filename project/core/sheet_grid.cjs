const { parse } = require('csv-parse/sync');

function encodeCol(index) {
  if (!Number.isInteger(index) || index < 0) throw new Error(`INVALID_COLUMN_INDEX:${index}`);
  let value = index + 1;
  let result = '';
  while (value > 0) {
    value -= 1;
    result = String.fromCharCode(65 + (value % 26)) + result;
    value = Math.floor(value / 26);
  }
  return result;
}

function decodeCol(label) {
  const text = String(label || '').toUpperCase();
  if (!/^[A-Z]+$/.test(text)) throw new Error(`INVALID_COLUMN_LABEL:${label}`);
  let result = 0;
  for (const char of text) result = result * 26 + char.charCodeAt(0) - 64;
  return result - 1;
}

function encodeCell({ r, c }) {
  if (!Number.isInteger(r) || r < 0) throw new Error(`INVALID_ROW_INDEX:${r}`);
  return `${encodeCol(c)}${r + 1}`;
}

function decodeCell(address) {
  const match = String(address || '').toUpperCase().match(/^([A-Z]+)([1-9]\d*)$/);
  if (!match) throw new Error(`INVALID_CELL_ADDRESS:${address}`);
  return { c: decodeCol(match[1]), r: Number(match[2]) - 1 };
}

function csvToSheet(csv) {
  const rows = parse(String(csv || ''), { bom: true, relax_column_count: true, skip_empty_lines: false });
  const sheet = {};
  for (let r = 0; r < rows.length; r += 1) {
    for (let c = 0; c < rows[r].length; c += 1) {
      const value = rows[r][c];
      if (value === '') continue;
      sheet[encodeCell({ r, c })] = { v: value, w: value };
    }
  }
  return sheet;
}

module.exports = { csvToSheet, encodeCol, decodeCol, encodeCell, decodeCell };
