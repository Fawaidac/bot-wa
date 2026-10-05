import mysql from "mysql2/promise";
import dotenv from "dotenv";
import fs from "node:fs";

dotenv.config();

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  connectionLimit: 5,
});

const DB = process.env.DB_NAME;
const out = { database: DB, tables: {}, foreignKeys: [] };

// 1. Daftar tabel + komentar + estimasi baris
const [tables] = await pool.execute(
  `SELECT TABLE_NAME, TABLE_COMMENT, TABLE_ROWS
   FROM INFORMATION_SCHEMA.TABLES
   WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE'
   ORDER BY TABLE_NAME`,
  [DB],
);
console.log(`Jumlah tabel: ${tables.length}`);

// 2. Semua kolom
const [cols] = await pool.execute(
  `SELECT TABLE_NAME, COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_KEY,
          COLUMN_DEFAULT, COLUMN_COMMENT, ORDINAL_POSITION
   FROM INFORMATION_SCHEMA.COLUMNS
   WHERE TABLE_SCHEMA = ?
   ORDER BY TABLE_NAME, ORDINAL_POSITION`,
  [DB],
);

// 3. Foreign keys / relasi
const [fks] = await pool.execute(
  `SELECT TABLE_NAME, COLUMN_NAME, REFERENCED_TABLE_NAME, REFERENCED_COLUMN_NAME
   FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE
   WHERE TABLE_SCHEMA = ? AND REFERENCED_TABLE_NAME IS NOT NULL`,
  [DB],
);
out.foreignKeys = fks.map(
  (r) =>
    `${r.TABLE_NAME}.${r.COLUMN_NAME} -> ${r.REFERENCED_TABLE_NAME}.${r.REFERENCED_COLUMN_NAME}`,
);

// Group kolom
for (const c of cols) {
  if (!out.tables[c.TABLE_NAME]) {
    const t = tables.find((x) => x.TABLE_NAME === c.TABLE_NAME);
    out.tables[c.TABLE_NAME] = {
      comment: t?.TABLE_COMMENT || "",
      estimatedRows: t?.TABLE_ROWS ?? null,
      columns: [],
    };
  }
  out.tables[c.TABLE_NAME].columns.push({
    name: c.COLUMN_NAME,
    type: c.COLUMN_TYPE,
    key: c.COLUMN_KEY,
    nullable: c.IS_NULLABLE === "YES",
    comment: c.COLUMN_COMMENT,
  });
}

// 4. Hitung baris pasti + sampling kolom kategorikal (enum/varchar kecil) utk
//    memahami kode status. Kolom dengan teks panjang (nama pasien dll) TIDAK diambil.
for (const [table, meta] of Object.entries(out.tables)) {
  try {
    const [[{ cnt }]] = await pool.execute(`SELECT COUNT(*) AS cnt FROM \`${table}\``);
    meta.rows = cnt;
  } catch (e) {
    meta.rows = "ERR: " + e.message;
  }

  meta.categorical = {};
  for (const col of meta.columns) {
    const isEnum = col.type.startsWith("enum");
    const isShortVarchar = /^(varchar|char|tinyint|smallint|tinytext)/.test(col.type);
    if (!isEnum && !isShortVarchar) continue;
    try {
      const [vals] = await pool.execute(
        `SELECT DISTINCT \`${col.name}\` AS v FROM \`${table}\`
         WHERE \`${col.name}\` IS NOT NULL LIMIT 15`,
      );
      const distinct = vals.map((r) => r.v).filter((v) => v !== null && v !== "");
      // Hanya simpan jika nilainya sedikit (kemungkinan kode status, bukan PII)
      if (distinct.length > 0 && distinct.length <= 15) {
        const asStr = distinct.map(String);
        const looksLikePii = asStr.some(
          (v) => /\d{6,}/.test(v) && v.length > 8, // panjang berisi angka = mrn/norm
        );
        if (!looksLikePii) meta.categorical[col.name] = asStr;
      }
    } catch {
      /* skip */
    }
  }
  process.stdout.write(".");
}

fs.writeFileSync(
  new URL("../.introspect_out.json", import.meta.url),
  JSON.stringify(out, null, 2),
);
console.log(`\nSelesai. Output: .introspect_out.json (${tables.length} tabel)`);
await pool.end();
