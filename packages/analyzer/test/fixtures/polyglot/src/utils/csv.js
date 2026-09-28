const path = require("path");

function toCsvRows(records, columns) {
  const header = columns.map((c) => c.label).join(",");
  const rows = [header];
  for (const record of records) {
    const cells = columns.map((c) => {
      const value = record[c.key];
      if (value === null || value === undefined) return "";
      const text = String(value).replace(/"/g, '""');
      return /[",\n]/.test(text) ? `"${text}"` : text;
    });
    rows.push(cells.join(","));
  }
  return rows.join("\n");
}

module.exports = { toCsvRows, outputName: (name) => path.join("out", name + ".csv") };
