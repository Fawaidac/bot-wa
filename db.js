import mysql from "mysql2/promise";
import dotenv from "dotenv";

dotenv.config();

// Koneksi Pool ke Database SIMRS
const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

// Fungsi untuk eksekusi query SELECT dengan proteksi keamanan
export async function safeQuery(sql, params = []) {
  const cleanSql = sql.trim().toLowerCase();

  // Validasi wajib diawali SELECT
  if (!cleanSql.startsWith("select")) {
    throw new Error(
      "Akses ditolak: Bot hanya diizinkan menjalankan perintah SELECT!",
    );
  }

  // Mencegah query pengubah data
  const forbidden = [
    "insert",
    "update",
    "delete",
    "drop",
    "truncate",
    "alter",
    "create",
  ];
  for (const word of forbidden) {
    if (cleanSql.includes(` ${word} `)) {
      throw new Error(`Kata kunci terlarang terdeteksi: ${word}`);
    }
  }

  const [rows] = await pool.execute(sql, params);
  return rows;
}

// Mengambil seluruh skema tabel & kolom dari database SIMRS secara otomatis
export async function getDatabaseSchema() {
  try {
    const sql = `
      SELECT TABLE_NAME, COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = ?
      ORDER BY TABLE_NAME, ORDINAL_POSITION;
    `;
    const [rows] = await pool.execute(sql, [process.env.DB_NAME]);

    // Grouping kolom berdasarkan nama tabel
    const schemaMap = {};
    rows.forEach((row) => {
      if (!schemaMap[row.TABLE_NAME]) {
        schemaMap[row.TABLE_NAME] = [];
      }
      schemaMap[row.TABLE_NAME].push(row.COLUMN_NAME);
    });

    let schemaText = `Daftar seluruh tabel dan kolom yang tersedia di database ${process.env.DB_NAME}:\n`;
    for (const [table, columns] of Object.entries(schemaMap)) {
      schemaText += `- Tabel \`${table}\`: (${columns.join(", ")})\n`;
    }

    return schemaText;
  } catch (error) {
    console.error("Gagal mengambil skema database:", error);
    return "Gagal membaca skema database.";
  }
}
