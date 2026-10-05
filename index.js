import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
} from "@whiskeysockets/baileys";
import qrcode from "qrcode-terminal";
import { GoogleGenAI, Type } from "@google/genai";
import OpenAI from "openai";
import mysql from "mysql2/promise";
import { safeQuery, getDatabaseSchema } from "./db.js";
import { getOptimizedSchemaSummary } from "./db_schema_catalog.js";
import dotenv from "dotenv";

dotenv.config();

// Konfigurasi Database untuk Tiket Pelaporan
const dbConfig = {
  host: process.env.DB_HOST2 || "localhost",
  port: parseInt(process.env.DB_PORT2, 10) || 3306,
  user: process.env.DB_USER2 || "admin",
  password: process.env.DB_PASSWORD2 || "",
  database: process.env.DB_NAME2 || "nama_db_anda",
};

const gemini = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash",
];

const OPENAI_COMPAT_PROVIDERS = [
  {
    name: "Groq",
    baseURL: "https://api.groq.com/openai/v1",
    envKey: "GROQ_API_KEY",
    models: ["qwen/qwen3.8-27b", "openai/gpt-oss-120b", "openai/gpt-oss-20b"],
  },
  {
    name: "Cerebras",
    baseURL: "https://api.cerebras.ai/v1",
    envKey: "CEREBRAS_API_KEY",
    models: ["gpt-oss-120b", "qwen-3.8-27b"],
  },
  {
    name: "Mistral",
    baseURL: "https://api.mistral.ai/v1",
    envKey: "MISTRAL_API_KEY",
    models: ["mistral-small-latest", "open-mistral-nemo"],
  },
  {
    name: "OpenRouter",
    baseURL: "https://openrouter.ai/api/v1",
    envKey: "OPENROUTER_API_KEY",
    models: [
      "qwen/qwen3.8-27b:free",
      "nvidia/nemotron-3-ultra-550b-a55b:free",
      "thinkingmachines/inkling-small:free",
      "inclusionai/ling-3.0-flash-vl:free",
      "google/gemma-4-31b-it:free",
      "z-ai/glm-5.2:free",
      "openrouter/free",
    ],
  },
];

const providerClients = new Map();
function getProviderClient(provider) {
  if (!providerClients.has(provider.name)) {
    providerClients.set(
      provider.name,
      new OpenAI({
        baseURL: provider.baseURL,
        apiKey: process.env[provider.envKey],
      }),
    );
  }
  return providerClients.get(provider.name);
}

const SHARE_LOCATION = {
  degreesLatitude: parseFloat(
    process.env.SHARE_LOCATION_LAT || "-8.187802446866938",
  ),
  degreesLongitude: parseFloat(
    process.env.SHARE_LOCATION_LNG || "113.75274171003682",
  ),
  name: process.env.SHARE_LOCATION_NAME || "Lokasi Kami",
  address: process.env.SHARE_LOCATION_ADDRESS || "",
};
SHARE_LOCATION.url = `https://maps.google.com/?q=${SHARE_LOCATION.degreesLatitude},${SHARE_LOCATION.degreesLongitude}`;

// Nomor eksekutif (TANPA @s.whatsapp.net, cukup angka nomor telepon)
const EXECUTIVE_NUMBERS = ["6281234567890"];

// Toggle permission AI per-user (default OFF, tiap orang harus mengaktifkan via !bot on)
// Menyimpan identifier unik user (nomor WA, LID, atau senderJid)
const botActiveUsers = new Set();

function isBotActiveForUser(sender) {
  if (sender.number && botActiveUsers.has(sender.number)) return true;
  if (sender.lid && botActiveUsers.has(sender.lid)) return true;
  if (sender.senderJid && botActiveUsers.has(sender.senderJid)) return true;
  return false;
}

function setBotActiveForUser(sender, active) {
  const identifiers = [sender.number, sender.lid, sender.senderJid].filter(Boolean);
  for (const id of identifiers) {
    if (active) {
      botActiveUsers.add(id);
    } else {
      botActiveUsers.delete(id);
    }
  }
}

let DYNAMIC_DATABASE_SCHEMA = "";

const geminiSqlTool = {
  name: "executeSqlQuery",
  description:
    "Menjalankan query SQL SELECT ke database SIMRS untuk mengambil data.",
  parameters: {
    type: Type.OBJECT,
    properties: {
      sql: {
        type: Type.STRING,
        description: "Query SQL SELECT yang valid dan aman",
      },
    },
    required: ["sql"],
  },
};

const fallbackSqlTool = {
  type: "function",
  function: {
    name: "executeSqlQuery",
    description:
      "Menjalankan query SQL SELECT ke database SIMRS untuk mengambil data.",
    parameters: {
      type: "object",
      properties: {
        sql: {
          type: "string",
          description: "Query SQL SELECT yang valid dan aman",
        },
      },
      required: ["sql"],
    },
  },
};

function formatTerminalLog(sql, engine = "Gemini AI", isExecutive = false) {
  if (isExecutive) {
    return `\`\`\`
● ○ ○  terminal — simrs-admin
---------------------------------
$ engine --use "${engine}"
$ sql --run "${sql}"

[+] Status : EXECUTING QUERY...
\`\`\`
_⏳ Sedang mengambil data & membaca SIMRS..._`;
  }

  return `\`\`\`
● ○ ○  terminal — simrs-guest
---------------------------------
$ simrs-cli --secure-mode

[+] Connection : ESTABLISHED
[+] Data Stream: FETCHING LIVE RECORDS...
\`\`\`
_⏳ Sedang membaca data SIMRS & menyusun jawaban..._`;
}

// =========================================================================
// HELPER LID / IDENTITAS PENGIRIM
// =========================================================================

/**
 * Ambil identitas pengirim yang benar, baik di chat pribadi maupun grup,
 * dan tahan terhadap format LID (@lid) dari WhatsApp terbaru.
 */
async function resolveSender(sock, msg) {
  const chatJid = msg.key.remoteJid;
  const isGroup = chatJid.endsWith("@g.us");

  // JID pengirim sebenarnya (grup = participant, private = remoteJid)
  const senderJid = isGroup ? msg.key.participant : chatJid;
  const altJid = isGroup ? msg.key.participantAlt : msg.key.remoteJidAlt;

  let pnJid = null; // JID format nomor telepon (@s.whatsapp.net)
  if (senderJid?.endsWith("@s.whatsapp.net")) {
    pnJid = senderJid;
  } else if (altJid?.endsWith("@s.whatsapp.net")) {
    pnJid = altJid;
  } else if (senderJid?.endsWith("@lid")) {
    try {
      pnJid = await sock.signalRepository?.lidMapping?.getPNForLID(senderJid);
    } catch {
      // mapping belum tersedia
    }
  }

  // Buang suffix device (":12") dan domain
  const clean = (j) => j?.split("@")[0].split(":")[0] || null;

  return {
    chatJid, // tujuan balasan (grup atau private)
    isGroup,
    senderJid, // JID asli pengirim (bisa @lid) → simpan untuk notifikasi
    number: clean(pnJid), // nomor telepon asli, null jika tidak bisa di-resolve
    lid: senderJid?.endsWith("@lid") ? clean(senderJid) : null,
  };
}

/**
 * Kirim pesan dengan log; jika gagal (mis. karena quoted), coba tanpa quoted.
 */
async function safeSend(sock, jid, content, quoted = null) {
  try {
    const sent = await sock.sendMessage(
      jid,
      content,
      quoted ? { quoted } : undefined,
    );
    console.log(
      "📤 Terkirim ke",
      jid,
      "id:",
      sent?.key?.id,
      "status:",
      sent?.status,
      "full_key:",
      JSON.stringify(sent?.key),
    );
    return sent;
  } catch (e) {
    console.warn("⚠️ Kirim gagal (dengan quoted), error:", e.message);
    console.warn("⚠️ Coba tanpa quoted...");
    try {
      const sent = await sock.sendMessage(jid, content);
      console.log(
        "📤 Terkirim (tanpa quoted) ke",
        jid,
        "id:",
        sent?.key?.id,
        "status:",
        sent?.status,
      );
      return sent;
    } catch (e2) {
      console.error("❌ Gagal kirim pesan ke", jid, ":", e2.message);
      return null;
    }
  }
}

/**
 * Buat saran tindakan awal (troubleshooting) untuk semua jenis permasalahan (Maintenance & SIMRS).
 * Jika ada di template mapping, gunakan mapping tersebut.
 * Jika tidak ada di mapping, gunakan AI untuk membuat saran yang tepat sasaran.
 */
async function getTroubleshootingAdvice(permasalahan) {
  const textLower = (permasalahan || "").toLowerCase();

  // 1. Cek apakah cocok dengan mapping template khusus
  let mappedSteps = null;

  if (
    textLower.includes("printer") ||
    textLower.includes("cetak") ||
    textLower.includes("kertas") ||
    textLower.includes("tinta") ||
    textLower.includes("toner") ||
    textLower.includes("sep")
  ) {
    mappedSteps = [
      "Pastikan kabel power dan kabel USB printer terhubung dengan rapat ke CPU/Laptop.",
      "Coba matikan printer selama 10 detik lalu nyalakan kembali.",
      "Cek apakah ada kertas macet (_paper jam_) atau lampu indikator tinta/error berkedip.",
    ];
  } else if (
    textLower.includes("wifi") ||
    textLower.includes("internet") ||
    textLower.includes("kabel") ||
    textLower.includes("lan") ||
    textLower.includes("jaringan") ||
    textLower.includes("rto")
  ) {
    mappedSteps = [
      "Periksa lampu indikator pada port kabel LAN (di belakang CPU) apakah menyala stabil.",
      "Coba cabut dan tancapkan kembali kabel LAN, atau _disconnect_ dan _reconnect_ Wi-Fi.",
      "Cek apakah komputer/perangkat lain di ruangan yang sama juga mengalami kendala serupa.",
    ];
  } else if (
    textLower.includes("mati") ||
    textLower.includes("komputer") ||
    textLower.includes("pc") ||
    textLower.includes("laptop") ||
    textLower.includes("monitor") ||
    textLower.includes("layar") ||
    textLower.includes("keyboard") ||
    textLower.includes("mouse") ||
    textLower.includes("ups") ||
    textLower.includes("blank")
  ) {
    mappedSteps = [
      "Pastikan kabel power ke stop kontak/UPS terpasang kencang dan tombol power UPS dalam posisi ON.",
      "Pastikan kabel display monitor (HDMI/VGA) terpasang kencang di port CPU.",
      "Jika komputer macet/freeze, tekan tombol power selama 10 detik untuk restart paksa.",
    ];
  } else if (
    textLower.includes("simrs") ||
    textLower.includes("rme") ||
    textLower.includes("aplikasi") ||
    textLower.includes("sistem") ||
    textLower.includes("login") ||
    textLower.includes("bridging") ||
    textLower.includes("bpjs") ||
    textLower.includes("vclaim") ||
    textLower.includes("satusehat") ||
    textLower.includes("error") ||
    textLower.includes("gagal") ||
    textLower.includes("resep")
  ) {
    mappedSteps = [
      "Tutup aplikasi SIMRS atau browser secara penuh (bisa melalui Task Manager jika macet), lalu buka kembali.",
      "Pastikan koneksi jaringan rumah sakit aktif dan tidak terputus.",
      "Coba lakukan logout akun dan login kembali untuk memperbarui sesi login.",
    ];
  }

  // Jika ada di mapping, langsung gunakan template mapping
  if (mappedSteps) {
    const stepsText = mappedSteps.map((s, idx) => `${idx + 1}. ${s}`).join("\n");
    return `💡 *SARAN TINDAKAN AWAL (TROUBLESHOOTING)*
_Sambil menunggu tim terkait merespons, Kakak bisa mencoba langkah berikut:_

${stepsText}

_Jika kendala masih berlanjut, mohon menunggu tim kami menuju ke ruangan / menangani laporan._ 🙏`;
  }

  // 2. Jika TIDAK ADA di mapping di atas, gunakan AI untuk generate saran troubleshooting
  try {
    const prompt = `Berikan 3 langkah singkat dan praktis tindakan awal (troubleshooting) untuk staf rumah sakit yang mengalami kendala IT / SIMRS / Hardware berikut: "${permasalahan}". Jawab HANYA berupa 3 poin bernomor tanpa salam pembuka atau penutup. Gunakan bahasa Indonesia yang ramah, ringkas, dan jelas.`;
    
    let aiText = null;
    try {
      const aiPromise = gemini.models.generateContent({
        model: GEMINI_MODELS[0],
        contents: prompt,
        config: { temperature: 0.2 },
      });
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout")), 3000),
      );
      const aiRes = await Promise.race([aiPromise, timeoutPromise]);
      aiText = typeof aiRes?.text === "function" ? aiRes.text() : aiRes?.text;
    } catch {
      // Fallback AI jika Gemini timeout
      try {
        aiText = await processWithFallback(prompt, "Kamu adalah asisten IT support rumah sakit.");
      } catch {}
    }

    if (aiText && aiText.trim().length > 15) {
      return `💡 *SARAN TINDAKAN AWAL (TROUBLESHOOTING)*
_Sambil menunggu tim terkait merespons, Kakak bisa mencoba langkah berikut:_

${aiText.trim()}

_Jika kendala masih berlanjut, mohon menunggu tim kami menuju ke ruangan / menangani laporan._ 🙏`;
    }
  } catch (err) {
    console.warn("⚠️ Gagal generate saran via AI:", err.message);
  }

  // 3. Fallback umum jika AI gagal
  const defaultSteps = [
    "Pastikan daya listrik dan koneksi jaringan perangkat terhubung dengan baik.",
    "Coba lakukan restart pada aplikasi atau perangkat yang bersangkutan.",
    "Catat atau screenshot pesan/kode error yang muncul untuk memudahkan penanganan tim teknis.",
  ];
  const stepsText = defaultSteps.map((s, idx) => `${idx + 1}. ${s}`).join("\n");
  return `💡 *SARAN TINDAKAN AWAL (TROUBLESHOOTING)*
_Sambil menunggu tim terkait merespons, Kakak bisa mencoba langkah berikut:_

${stepsText}

_Jika kendala masih berlanjut, mohon menunggu tim kami menuju ke ruangan / menangani laporan._ 🙏`;
}

// =========================================================================
// GEMINI
// =========================================================================
async function processWithGemini(
  userMessage,
  systemInstruction,
  onProgress = null,
  isExecutive = false,
) {
  let lastError = null;

  for (const model of GEMINI_MODELS) {
    for (let attempt = 1; attempt <= 2; attempt++) {
      console.log(
        `🤖 [Primary] Memproses dengan Gemini API (${model})... (percobaan ${attempt}/2)`,
      );

      try {
        const response = await gemini.models.generateContent({
          model,
          contents: userMessage,
          config: {
            systemInstruction,
            tools: [{ functionDeclarations: [geminiSqlTool] }],
            temperature: 0.1,
          },
        });

        const functionCalls = response.functionCalls;
        if (functionCalls && functionCalls.length > 0) {
          const call = functionCalls[0];
          if (call.name === "executeSqlQuery") {
            const generatedSql = call.args.sql;
            console.log(`🤖 Gemini Generated SQL: ${generatedSql}`);

            // Kirim notifikasi terminal tersamarkan ke WhatsApp
            if (typeof onProgress === "function") {
              try {
                await onProgress(
                  formatTerminalLog(
                    generatedSql,
                    `Gemini (${model})`,
                    isExecutive,
                  ),
                );
              } catch (notifyErr) {
                console.warn(
                  "⚠️ Gagal mengirim pesan progress terminal:",
                  notifyErr.message,
                );
              }
            }

            let queryResult;
            try {
              queryResult = await safeQuery(generatedSql);
            } catch (err) {
              queryResult = { error_database: err.message };
            }

            // Riwayat percakapan: user → model (tool call) → functionResponse
            const conversation = [
              { role: "user", parts: [{ text: userMessage }] },
              { role: "model", parts: response.candidates[0].content.parts },
              {
                role: "user",
                parts: [
                  {
                    functionResponse: {
                      name: "executeSqlQuery",
                      response: { content: queryResult },
                    },
                  },
                ],
              },
            ];

            if (queryResult.error_database) {
              // Ronde koreksi: SQL salah kolom/tabel → minta Gemini memperbaiki
              // berdasarkan pesan error (tool masih aktif), maksimal 1x.
              console.warn(
                `⚠️ Gemini SQL error (${model}): ${queryResult.error_database} → minta koreksi query...`,
              );
              const errorMsgText = `Query SQL tersebut error: ${queryResult.error_database}. Perbaiki query-nya (cek nama tabel & kolom sesuai skema database) lalu panggil executeSqlQuery lagi dengan query yang sudah diperbaiki.`;
              const retryResponse = await gemini.models.generateContent({
                model,
                contents: [
                  ...conversation,
                  { role: "user", parts: [{ text: errorMsgText }] },
                ],
                config: {
                  systemInstruction,
                  tools: [{ functionDeclarations: [geminiSqlTool] }],
                  temperature: 0.1,
                },
              });

              const retryCalls = retryResponse.functionCalls;
              if (
                retryCalls &&
                retryCalls.length > 0 &&
                retryCalls[0].name === "executeSqlQuery"
              ) {
                const fixedSql = retryCalls[0].args.sql;
                console.log(`🤖 Gemini Generated SQL (koreksi): ${fixedSql}`);
                if (typeof onProgress === "function") {
                  try {
                    await onProgress(
                      formatTerminalLog(
                        fixedSql,
                        `Gemini (${model})`,
                        isExecutive,
                      ),
                    );
                  } catch (notifyErr) {
                    console.warn(
                      "⚠️ Gagal mengirim pesan progress terminal:",
                      notifyErr.message,
                    );
                  }
                }
                let fixedResult;
                try {
                  fixedResult = await safeQuery(fixedSql);
                } catch (err) {
                  fixedResult = { error_database: err.message };
                }
                conversation.push({
                  role: "user",
                  parts: [{ text: errorMsgText }],
                });
                conversation.push({
                  role: "model",
                  parts: retryResponse.candidates[0].content.parts,
                });
                conversation.push({
                  role: "user",
                  parts: [
                    {
                      functionResponse: {
                        name: "executeSqlQuery",
                        response: { content: fixedResult },
                      },
                    },
                  ],
                });
                const finalAfterRetry = await gemini.models.generateContent({
                  model,
                  contents: conversation,
                  config: { systemInstruction },
                });
                return finalAfterRetry.text;
              }

              // Model tidak memanggil tool lagi → minta penjelasan error
              const finalExplain = await gemini.models.generateContent({
                model,
                contents: [
                  ...conversation,
                  { role: "user", parts: [{ text: errorMsgText }] },
                ],
                config: { systemInstruction },
              });
              return finalExplain.text;
            }

            const secondResponse = await gemini.models.generateContent({
              model,
              contents: conversation,
              config: { systemInstruction },
            });

            return secondResponse.text;
          }
        }

        return response.text;
      } catch (error) {
        lastError = error;
        console.warn(
          `⚠️ Gemini Error (${model}, percobaan ${attempt}/2):`,
          error.message,
        );

        // 429 / kuota habis → TIDAK retry ke model yang sama,
        // langsung break ke model berikutnya (kuotanya juga terpisah)
        if (isQuotaExhaustedError(error)) {
          break;
        }

        // 503 = server sibuk sementara → tunggu lalu coba lagi model yang sama
        if (isRetryableError(error) && attempt < 2) {
          const waitMs =
            extractRetryDelay(error) ||
            Math.min(1000 * Math.pow(2, attempt), 15000);
          console.log(`⏳ Tunggu ${Math.round(waitMs)}ms sebelum retry...`);
          await new Promise((resolve) => setTimeout(resolve, waitMs));
          continue;
        }

        // Error lain (404 model, 400, dll.) → lanjut ke model berikutnya
        break;
      }
    }
  }

  // Semua model gagal, lempar error terakhir
  throw lastError || new Error("Semua model Gemini gagal dihubungi.");
}

/**
 * Tentukan apakah error tersebut layak untuk di-retry di model yang sama (503).
 */
function isRetryableError(error) {
  const status = error?.status || error?.response?.status;
  return status === 503 || status === 429;
}

/**
 * 429 / RESOURCE_EXHAUSTED = kuota free tier model terpakai habis.
 * Retry ke model yang sama percuma → langsung rotasi ke model berikutnya.
 */
function isQuotaExhaustedError(error) {
  const status = error?.status || error?.response?.status;
  const message = String(error?.message || "");
  return (
    status === 429 ||
    message.includes("RESOURCE_EXHAUSTED") ||
    message.includes("exceeded your current quota") ||
    message.includes("Quota exceeded")
  );
}

// =========================================================================
// OTOMATISASI SCHEMA & SEED DATA PETUGAS DEFAULTS
// =========================================================================
async function initDatabase() {
  try {
    const connection = await mysql.createConnection(dbConfig);

    // 1. Buat Tabel petugas_pde jika belum ada
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS petugas_pde (
          id INT AUTO_INCREMENT PRIMARY KEY,
          nama_petugas VARCHAR(100) NOT NULL,
          no_wa VARCHAR(30) NOT NULL UNIQUE
      );
    `);

    // 2. Buat Tabel tikets jika belum ada
    await connection.execute(`
      CREATE TABLE IF NOT EXISTS tikets (
          id INT AUTO_INCREMENT PRIMARY KEY,
          nama_pelapor VARCHAR(100) NOT NULL,
          ruangan VARCHAR(100) NOT NULL,
          permasalahan TEXT NOT NULL,
          no_wa_pelapor VARCHAR(30) NOT NULL,
          no_wa_penangan VARCHAR(30) DEFAULT NULL,
          nama_penangan VARCHAR(100) DEFAULT NULL,
          status ENUM('PENDING', 'SELESAI') DEFAULT 'PENDING',
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      );
    `);

    // 3. Tambah kolom baru untuk dukungan LID (aman dijalankan berulang)
    const addColumn = async (sql) => {
      try {
        await connection.execute(sql);
      } catch (e) {
        if (e.code !== "ER_DUP_FIELDNAME") throw e;
      }
    };
    await addColumn(
      "ALTER TABLE tikets ADD COLUMN jid_pelapor VARCHAR(100) DEFAULT NULL",
    );
    await addColumn(
      "ALTER TABLE petugas_pde ADD COLUMN lid VARCHAR(50) DEFAULT NULL",
    );

    // 4. Insert / Update Data Master Petugas PDE & Maintenance secara Otomatis
    const masterPetugas = [
      // Tim PDE
      { nama: "DIFAN", no_wa: "6289509905555" },
      { nama: "DHETA BAIK", no_wa: "6281230175921" },
      // Tim Maintenance
      { nama: "FIKRUS", no_wa: "6285816772034" },
      { nama: "SIGIT", no_wa: "6289654964783" },
      { nama: "HAKUL", no_wa: "6285258801679" },
      { nama: "ERFAN", no_wa: "6289672488255" },
    ];

    for (const p of masterPetugas) {
      await connection.execute(
        `INSERT INTO petugas_pde (nama_petugas, no_wa) 
         VALUES (?, ?) 
         ON DUPLICATE KEY UPDATE nama_petugas = VALUES(nama_petugas)`,
        [p.nama, p.no_wa],
      );
    }

    await connection.end();
    console.log(
      "✅ Database initialized & master data petugas successfully synced!",
    );
  } catch (error) {
    console.error("❌ Error initializing database:", error.message);
  }
}

/**
 * Ekstrak retryDelay dari error response jika tersedia (Gemini 429 / 503).
 * Fallback ke exponential backoff jika tidak ada.
 */
function extractRetryDelay(error) {
  try {
    const details = error?.details || [];
    for (const detail of details) {
      if (detail?.retryDelay) {
        return detail.retryDelay * 1000; // dialihkan ke milidetik
      }
    }

    // Coba parsing dari message error (JSON tertanam)
    const message = error?.message || "";
    const jsonMatch = message.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (parsed?.details?.[0]?.retryDelay) {
        return parsed.details[0].retryDelay * 1000;
      }
    }
  } catch {
    // fallback
  }

  return null;
}

function extractSqlFromText(text) {
  if (typeof text !== "string" || text.length === 0) return null;
  if (!/executeSqlQuery|<invoke|<function=/i.test(text)) return null;
  let candidate = null;
  const param = text.match(
    /<parameter[^>]*name=[\x22\x27]sql[\x22\x27][^>]*>([\s\S]*?)<\/parameter>/i,
  );
  if (param) candidate = param[1];
  if (candidate === null) {
    const fence = text.match(/```(?:sql)?\s*(SELECT[\s\S]*?)```/i);
    if (fence) candidate = fence[1];
  }
  if (candidate === null) {
    // Gaya tool call JSON: {"sql": "SELECT ..."}
    const json = text.match(/["']sql["']\s*:\s*"((?:[^"\\]|\\.)*)"/i);
    if (json) {
      try {
        candidate = JSON.parse('{"sql":"' + json[1] + '"}').sql;
      } catch {
        candidate = json[1];
      }
    }
  }
  if (candidate === null) {
    const plain = text.match(/\bSELECT[\s\S]+/i);
    if (plain) candidate = plain[0];
  }
  if (!candidate) return null;
  candidate = candidate
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .replace(/<\/?parameter[^>]*>/gi, "")
    .trim()
    // Buang sisa sintaks non-SQL di ekor (kutip kurung-tutup dari JSON args, backtick, titik-koma)
    .replace(/[;`"'`,}\]]+\s*$/, "");
  return /^select\b/i.test(candidate) ? candidate : null;
}

// Bersihkan sisa blok pemanggilan tool yang lolos ke balasan akhir (mis. dari
// model fallback yang menulis tool call sebagai teks) agar tidak terkirim ke WA.
function sanitizeReply(text) {
  if (typeof text !== "string" || text.length === 0) return text;
  return text
    .replace(/<function=[^>]*>[\s\S]*?<\/function>/gi, "")
    .replace(/<invoke[^>]*>[\s\S]*?<\/invoke>/gi, "")
    .replace(/```[\s\S]*?(?:executeSqlQuery|<invoke)[\s\S]*?```/gi, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

async function createCompletion(client, payload) {
  try {
    return await client.chat.completions.create(payload);
  } catch (error) {
    const msg = String(error?.message || "");
    if (payload.tools && /tool choice is none/i.test(msg)) {
      console.warn(
        "⚠️ Provider menolak konfigurasi tools (tool choice) → ulangi tanpa 'tools'; SQL akan ditangkap dari teks.",
      );
      const retryPayload = { ...payload };
      delete retryPayload.tools;
      delete retryPayload.tool_choice;
      return await client.chat.completions.create(retryPayload);
    }
    throw error;
  }
}

async function tryFallbackModel(
  client,
  model,
  userMessage,
  systemInstruction,
  providerName = "Fallback AI",
  onProgress = null,
  isExecutive = false,
) {
  const messages = [
    { role: "system", content: systemInstruction },
    { role: "user", content: userMessage },
  ];

  let finalContent = null;

  // Maksimal 2 ronde query SQL (ronde ke-2 = koreksi jika SQL pertama error)
  for (let round = 1; round <= 2 && finalContent === null; round++) {
    const response = await createCompletion(client, {
      model,
      messages,
      tools: [fallbackSqlTool],
      tool_choice: "auto",
      temperature: 0.1,
    });

    const msg = response.choices[0].message;

    // (a) tool call resmi format OpenAI, ATAU
    // (b) tool call yang ditulis model sebagai teks mentah (Qwen/GPT-OSS)
    let sql = null;
    let toolCall = null;
    if (msg.tool_calls && msg.tool_calls.length > 0) {
      toolCall = msg.tool_calls[0];
      try {
        sql = JSON.parse(toolCall.function.arguments)?.sql;
      } catch {
        sql = null;
      }
    } else if (msg.content) {
      sql = extractSqlFromText(msg.content);
    }

    if (!sql) {
      finalContent = msg.content;
      break;
    }

    console.log(`⚡ Fallback Generated SQL (${model}, ronde ${round}): ${sql}`);

    if (typeof onProgress === "function") {
      try {
        await onProgress(
          formatTerminalLog(sql, `${providerName} (${model})`, isExecutive),
        );
      } catch (notifyErr) {
        console.warn(
          "⚠️ Gagal mengirim pesan progress terminal:",
          notifyErr.message,
        );
      }
    }

    let queryResult;
    try {
      queryResult = await safeQuery(sql);
    } catch (err) {
      queryResult = { error_database: err.message };
    }

    // Susun riwayat percakapan (aman untuk semua provider)
    const assistantMsg = { role: "assistant", content: msg.content ?? null };
    if (toolCall) assistantMsg.tool_calls = msg.tool_calls;
    messages.push(assistantMsg);

    if (toolCall) {
      messages.push({
        role: "tool",
        tool_call_id: toolCall.id,
        content: JSON.stringify(queryResult),
      });
    } else {
      messages.push({
        role: "user",
        content: `Hasil eksekusi query SQL:\n${JSON.stringify(queryResult)}\n\nBerdasarkan hasil di atas, jawab pertanyaan saya. Jika ada "error_database", perbaiki query SQL (cek nama tabel & kolom sesuai skema database) lalu panggil tool executeSqlQuery lagi.`,
      });
    }

    if (!queryResult.error_database) {
      // Data valid → minta jawaban akhir TANPA tools (hindari error tool_choice
      // pada model yang tidak mendukung tools di panggilan kedua)
      const finalResponse = await client.chat.completions.create({
        model,
        messages,
        temperature: 0.1,
      });
      finalContent = finalResponse.choices[0].message.content;
      break;
    }
    // SQL error → lanjut ronde 2 dengan umpan balik error di messages
  }

  if (finalContent === null) {
    const finalResponse = await client.chat.completions.create({
      model,
      messages,
      temperature: 0.1,
    });
    finalContent = finalResponse.choices[0].message.content;
  }

  return finalContent;
}

async function processWithFallback(
  userMessage,
  systemInstruction,
  onProgress = null,
  isExecutive = false,
) {
  let lastError = null;

  for (const provider of OPENAI_COMPAT_PROVIDERS) {
    if (!process.env[provider.envKey]) {
      console.log(
        `⏭️ [Fallback] ${provider.name} dilewati (${provider.envKey} belum diisi di .env)`,
      );
      continue;
    }

    const client = getProviderClient(provider);

    for (const model of provider.models) {
      console.log(`⚡ [Fallback] Mencoba ${provider.name} → ${model}...`);
      try {
        const reply = await tryFallbackModel(
          client,
          model,
          userMessage,
          systemInstruction,
          provider.name,
          onProgress,
          isExecutive,
        );
        if (reply && reply.trim() !== "") {
          console.log(`✅ [Fallback] Berhasil via ${provider.name} (${model})`);
          return reply;
        }
        lastError = new Error(`Respons kosong dari ${provider.name}/${model}`);
      } catch (err) {
        lastError = err;
        console.warn(
          `⚠️ [Fallback] ${provider.name}/${model} gagal:`,
          err.message,
        );
      }
    }
  }

  throw (
    lastError ||
    new Error(
      "Tidak ada provider fallback yang aktif. Isi GROQ_API_KEY / CEREBRAS_API_KEY / MISTRAL_API_KEY di .env untuk menambah AI gratis.",
    )
  );
}

// --- DETEKSI PERMINTAAN SHARE LOKASI (fast path, TANPA AI → hemat kuota) ---
function isLocationRequest(text) {
  const t = text
    .toLowerCase()
    .replace(/[!?.,;:]+$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  // 1. Kata gaul share location: "shareloc", "shrelok", "share lok", dll.
  if (/(share\s*lo[cgk]|sharelok|shrelok)/.test(t)) return true;

  // 2. Permintaan eksplisit di awal pesan
  if (
    /^(kirim|minta|tolong(?: kirim)?|boleh(?: kirim)?|tolong minta)\s+(share\s*lo\w*|lokasi(?:nya)?|pin(?:\s*lokasi)?|titik(?:\s*lokasi)?)\b/.test(
      t,
    )
  ) {
    return true;
  }

  // 3. Pertanyaan polos yang pendek (≤6 kata) dengan "mana/dimana" + kata lokasi
  const isShort = t.split(" ").length <= 6;
  if (
    isShort &&
    /(mana|dimana)/.test(t) &&
    /(lokasi|posisi|pin|share)/.test(t)
  ) {
    return true;
  }

  // 4. Kata tunggal / frasa pas
  if (
    ["lokasi", "lokasinya", "kirim lokasi", "kirim pin", "share loc"].includes(
      t,
    )
  ) {
    return true;
  }

  return false;
}

// --- ROUTER MANAGER ---
async function processAiMessage(
  userMessage,
  isExecutive = true,
  onProgress = null,
) {
  const systemInstruction = `Kamu adalah Asisten AI Internal Resmi Rumah Sakit yang terhubung langsung ke seluruh database SIMRS.

INFORMASI STRUKTUR DATABASE SIMRS:
${DYNAMIC_DATABASE_SCHEMA}

Aturan Hak Akses & Privasi:
- Pengguna yang mengakses bot ini adalah PETUGAS INTERNAL / MANAJEMEN / ATASAN RUMAH SAKIT yang memiliki HAK AKSES RESMI & PENUH ke seluruh data SIMRS.
- JANGAN PERNAH MENOLAK permintaan dengan alasan privasi/keamanan data/akses terbatas/bukan pasien bersangkutan.
- Kamu DIIZINKAN dan DIWAJIBKAN membantu mencari data pasien, data rekam medis (No. RM, nama pasien, riwayat periksa/diagnosa/tindakan/obat), jadwal dokter, ketersediaan kamar, data registrasi, maupun laporan SIMRS lainnya.
- Langsung jalankan query SQL SELECT ke tabel yang sesuai untuk menjawab pertanyaan pengguna.

PANDUAN JADWAL DOKTER (pertanyaan paling sering — wajib ikuti):
- Untuk jadwal dokter gunakan tabel c_ms_jadwal_dokter (kolom: namadokter, namapoli, namasubspesialis, namahari, hari, jadwal, kapasitaspasien, libur) — LENGKAP, TIDAK PERLU JOIN.
- Kolom hari memakai nama hari BAHASA INDONESIA ('SENIN'..'SABTU'), bukan Inggris. JANGAN pakai DAYNAME()/DATE_FORMAT() yang menghasilkan 'Monday'/'Friday'.
- Template "jadwal besok": WHERE namahari = CASE DAYOFWEEK(CURDATE() + INTERVAL 1 DAY) WHEN 2 THEN 'SENIN' WHEN 3 THEN 'SELASA' WHEN 4 THEN 'RABU' WHEN 5 THEN 'KAMIS' WHEN 6 THEN 'JUMAT' WHEN 7 THEN 'SABTU' ELSE 'MINGGU' END AND (libur = 0 OR libur IS NULL)
- Filter poli: LOWER(namapoli) LIKE '%kata kunci%'.
- libur: 0/NULL = jadwal berlaku (baris poli tanpa dokter spesifik — mis. GIGI — memakai NULL); 1 = libur. 'LIBUR NASIONAL' tidak akan cocok dengan CASE template di atas.
- Jika hasil jadwal kosong, sampaikan dengan ramah jadwal tidak tersedia hari itu (mis. poli mata hanya SENIN-JUMAT) — JANGAN mengulang query dengan tanggal berbeda.
- Alternatif dengan JOIN: b_ms_jadwal_dokter (id_pegawai, id_unit, jam_mulai, jam_selesai, status) JOIN b_ms_pegawai (nama, spesialisasi) JOIN b_ms_unit (nama). b_ms_pegawai TIDAK punya kolom unit_id!

PANDUAN PENCARIAN PASIEN & REKAM MEDIS:
- Jika pengguna mencari data pasien/RM (misal: "rm RATNA INDRAWATI", "cari pasien budi", dll), cari di tabel pasien atau tabel registrasi/rekam medis yang relevan menggunakan query SELECT dengan LIKE '%nama%'.
- Tampilkan informasi yang relevan seperti No. RM, Nama Pasien, Jenis Kelamin, Tanggal Lahir/Umur, Alamat, atau riwayat periksa jika diminta.

Tugas Utama:
- Pilih tabel dan kolom yang paling relevan dari skema database di atas berdasarkan pertanyaan pengguna.
- Panggil tool 'executeSqlQuery' dengan query SELECT MySQL yang sesuai.
- Gunakan LIMIT (maksimal 20-30 baris) agar hasil query tidak terlalu besar.
- Jika query menghasilkan data kosong/array kosong, sampaikan secara ramah bahwa data tidak ditemukan di database SIMRS.
- Susun balasan akhir dengan ramah, komunikatif, dan rapi menggunakan format WhatsApp (*bold*, bullet points).`;

  // 1. Coba Gemini dengan rotasi multi-model + retry otomatis
  try {
    const reply = await processWithGemini(
      userMessage,
      systemInstruction,
      onProgress,
      isExecutive,
    );
    if (reply && reply.trim() !== "") return reply;
  } catch (geminiError) {
    console.warn(
      "⚠️ Semua model Gemini gagal, beralih ke fallback:",
      geminiError.message,
    );
  }

  // 2. Coba fallback berantai (Groq / Cerebras / Mistral / OpenRouter)
  try {
    const reply = await processWithFallback(
      userMessage,
      systemInstruction,
      onProgress,
      isExecutive,
    );
    if (reply && reply.trim() !== "") return reply;
  } catch (fallbackError) {
    console.error("❌ Semua fallback AI juga gagal:", fallbackError.message);
  }

  // 3. Jika seluruh AI gagal, beri pesan yang informatif
  return "Maaf, seluruh layanan AI (Gemini & fallback) sedang kehabisan kuota gratis. Silakan coba tanyakan kembali dalam beberapa saat.";
}

// --- BOT STARTUP ---
async function startBot() {
  await initDatabase();

  console.log("🔄 Memuat katalog skema tabel SIMRS teroptimasi...");
  DYNAMIC_DATABASE_SCHEMA = getOptimizedSchemaSummary();
  console.log("✅ Skema tabel SIMRS hemat-token berhasil dimuat!");

  const { state, saveCreds } = await useMultiFileAuthState("auth_info");

  // Cache metadata grup agar Baileys tahu addressing mode (LID vs PN)
  // Ini WAJIB untuk Baileys v7 agar pesan ke grup LID benar-benar terkirim
  const groupMetadataCache = new Map();

  const sock = makeWASocket({
    auth: state,
    printQRInTerminal: false,
    cachedGroupMetadata: async (jid) => {
      if (groupMetadataCache.has(jid)) {
        return groupMetadataCache.get(jid);
      }
      try {
        const metadata = await sock.groupMetadata(jid);
        groupMetadataCache.set(jid, metadata);
        console.log(
          `📋 Group metadata cached: ${jid} (addressing: ${metadata.addressingMode || "unknown"})`,
        );
        return metadata;
      } catch (e) {
        console.warn(`⚠️ Gagal fetch metadata grup ${jid}:`, e.message);
        return undefined;
      }
    },
  });

  sock.ev.on("creds.update", saveCreds);

  // Track status pengiriman pesan (debug: apakah pesan benar2 delivered)
  sock.ev.on("messages.update", (updates) => {
    for (const { key, update } of updates) {
      if (key.fromMe && update.status) {
        const statusMap = {
          1: "PENDING",
          2: "SERVER_ACK",
          3: "DELIVERY_ACK",
          4: "READ",
        };
        console.log(
          `📨 Message ${key.id} → ${statusMap[update.status] || update.status} (to: ${key.remoteJid})`,
        );
      }
    }
  });

  sock.ev.on("connection.update", (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log("📱 Scan QR Code di WhatsApp RS:");
      qrcode.generate(qr, { small: true });
    }

    if (connection === "close") {
      const shouldReconnect =
        lastDisconnect?.error?.output?.statusCode !==
        DisconnectReason.loggedOut;
      console.log("Koneksi terputus. Menghubungkan ulang...", shouldReconnect);
      if (shouldReconnect) startBot();
    } else if (connection === "open") {
      console.log("✅ Bot WhatsApp AI SIMRS Aktif!");
      // Pre-cache metadata grup yang sudah pernah dipakai
      console.log("🔄 Pre-loading group metadata cache...");
    }
  });

  sock.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") return;

    for (const msg of messages) {
      if (!msg.message || msg.key.fromMe) continue;

      // chatJid = tempat membalas (grup / private). Nama lama: senderJid.
      const chatJid = msg.key.remoteJid;
      const textMessage = (
        msg.message.conversation ||
        msg.message.extendedTextMessage?.text ||
        ""
      ).trim();

      if (!textMessage) continue;

      // Identitas pengirim yang aman untuk LID
      const sender = await resolveSender(sock, msg);
      console.log(`📩 Pesan dari ${chatJid}: "${textMessage}"`);
      console.log("KEY:", JSON.stringify(msg.key), "→ resolved:", sender);

      // Fast path 1: ada yang minta sharelok (mis. kurir) → kirim PIN lokasi
      // langsung TANPA memanggil AI (respons instan + hemat kuota)
      if (isLocationRequest(textMessage)) {
        console.log(
          `📍 Permintaan lokasi terdeteksi → kirim PIN ke ${chatJid}`,
        );
        const location = {
          degreesLatitude: SHARE_LOCATION.degreesLatitude,
          degreesLongitude: SHARE_LOCATION.degreesLongitude,
          name: SHARE_LOCATION.name,
          url: SHARE_LOCATION.url,
        };
        if (SHARE_LOCATION.address) location.address = SHARE_LOCATION.address;
        await safeSend(sock, chatJid, { location }, msg);
        continue;
      }

      // =========================================================================
      // DEBUG: !ping untuk test kirim pesan ke grup
      // =========================================================================
      const textLowerCmd = textMessage.toLowerCase().trim();
      if (textLowerCmd === "!ping") {
        console.log(`🏓 PING dari ${chatJid}, mencoba kirim balasan...`);
        // Test 1: kirim dengan quoted
        const r1 = await safeSend(
          sock,
          chatJid,
          { text: "🏓 *PONG!* Bot aktif dan bisa kirim pesan." },
          msg,
        );
        console.log("🏓 PING result (quoted):", JSON.stringify(r1?.key));
        // Test 2: kirim tanpa quoted
        const r2 = await sock.sendMessage(chatJid, {
          text: "🏓 Test kirim tanpa quoted",
        });
        console.log("🏓 PING result (no-quoted):", JSON.stringify(r2?.key));
        continue;
      }

      // =========================================================================
      // TOGGLE PERMISSION AI: !bot on / !bot off (per-user, default OFF)
      // Fitur Pelaporan Tiket & Done TIDAK perlu permission ini.
      // =========================================================================
      if (textLowerCmd === "!bot on") {
        setBotActiveForUser(sender, true);
        const userLabel = sender.number ? `+${sender.number}` : (sender.lid || "Anda");
        console.log(`🤖 Bot AI ACTIVATED untuk user ${userLabel} di ${chatJid}`);
        await safeSend(
          sock,
          chatJid,
          {
            text: "✅ *Bot AI SIMRS Aktif untuk Anda!*\nSilakan ajukan pertanyaan seputar data SIMRS.\nKetik *!bot off* untuk menonaktifkan.",
          },
          msg,
        );
        continue;
      }
      if (textLowerCmd === "!bot off") {
        setBotActiveForUser(sender, false);
        const userLabel = sender.number ? `+${sender.number}` : (sender.lid || "Anda");
        console.log(`🤖 Bot AI DEACTIVATED untuk user ${userLabel} di ${chatJid}`);
        await safeSend(
          sock,
          chatJid,
          {
            text: "🔴 *Bot AI SIMRS Nonaktif untuk Anda.*\nBot tidak akan membalas pertanyaan Anda hingga diaktifkan kembali dengan *!bot on*.\n\n_Fitur Pelaporan Tiket tetap aktif._",
          },
          msg,
        );
        continue;
      }

      // =========================================================================
      // Fast path 2: REGISTRASI PELAPORAN TIKET (SIMRS / RME / MAINTENANCE)
      // =========================================================================
      if (
        textMessage.toLowerCase().includes("nama pelapor") ||
        textMessage.toLowerCase().includes("format pelaporan")
      ) {
        try {
          const namaMatch = textMessage.match(
            /Nama\s*pelapor\s*:\s*([^\n\r]*)/i,
          );
          const ruanganMatch = textMessage.match(/Ruangan\s*:\s*([^\n\r]*)/i);
          const masalahMatch = textMessage.match(
            /Permasalahan\s*:\s*([\s\S]*)/i,
          );

          const namaPelapor = namaMatch ? namaMatch[1].trim() : "";
          const ruangan = ruanganMatch ? ruanganMatch[1].trim() : "";

          let permasalahan = "";
          if (masalahMatch) {
            permasalahan = masalahMatch[1].trim();
            permasalahan = permasalahan
              .replace(/(?:Terimakasih|Terima\s*kasih).*/is, "")
              .trim();
          }

          // Validasi kelengkapan format pelaporan
          if (!namaPelapor || !ruangan || !permasalahan) {
            const pesanValidasi = `⚠️ *Format Pelaporan Belum Lengkap!*

Mohon lengkapi seluruh kolom format pelaporan (tidak boleh ada yang kosong):
- *Nama pelapor :* ${namaPelapor ? "✅ " + namaPelapor : "❌ (Wajib diisi)"}
- *Ruangan :* ${ruangan ? "✅ " + ruangan : "❌ (Wajib diisi)"}
- *Permasalahan :* ${permasalahan ? "✅ " + permasalahan : "❌ (Wajib diisi)"}

*Contoh Format yang Benar:*
format Pelaporan SIM RS/RME
Nama pelapor : ?
Ruangan : ?
Permasalahan : ?
Terimakasih🙏🙏`;

            await safeSend(sock, sender.chatJid, { text: pesanValidasi }, msg);
            continue;
          }

          // 1. Identitas pelapor (nomor asli jika ada, kalau tidak pakai LID)
          const noWaPelapor = sender.number || sender.lid || "unknown";
          const jidPelapor = sender.senderJid || null;

          // 2. Daftar Kata Kunci (Keywords) untuk Deteksi Presisi
          const maintenanceKeywords = [
            "printer",
            "cetak",
            "kertas",
            "tinta",
            "toner",
            "hardware",
            "komputer",
            "pc",
            "laptop",
            "monitor",
            "layar",
            "keyboard",
            "mouse",
            "mati",
            "mati total",
            "wifi",
            "internet",
            "kabel",
            "lan",
            "ups",
            "jaringan",
          ];

          const simrsKeywords = [
            "simrs",
            "sim rs",
            "rme",
            "rekam medis",
            "aplikasi",
            "sistem",
            "login",
            "bridging",
            "vclaim",
            "bpjs",
            "satusehat",
            "resep",
            "epreskripsi",
            "error",
            "gagal simpan",
            "lemot",
            "menu",
            "modul",
          ];

          const textLower = textMessage.toLowerCase();

          // Prioritaskan cek keyword Maintenance / Hardware terlebih dahulu
          const isMaintenance = maintenanceKeywords.some((key) =>
            textLower.includes(key),
          );
          const isSimrs = simrsKeywords.some((key) => textLower.includes(key));

          // 3. Tentukan Team / CP Balasan Dinamis
          let kontakTeamText = "";

          if (isMaintenance) {
            kontakTeamText = `*TEAM MAINTENANCE*
1. FIKRUS (085816772034)
2. SIGIT (089654964783)
3. HAKUL (085258801679)
4. ERFAN (089672488255)`;
          } else if (isSimrs) {
            kontakTeamText = `*TEAM PDE*
1. DIFAN (089509905555)
2. DHETA BAIK (081230175921)`;
          } else {
            // Default fallback → TEAM PDE
            kontakTeamText = `*TEAM PDE*
1. DIFAN (089509905555)
2. DHETA BAIK (081230175921)`;
          }

          // 4. Simpan ke Database
          const connection = await mysql.createConnection(dbConfig);
          const [result] = await connection.execute(
            `INSERT INTO tikets (nama_pelapor, ruangan, permasalahan, no_wa_pelapor, jid_pelapor, status) 
             VALUES (?, ?, ?, ?, ?, 'PENDING')`,
            [namaPelapor, ruangan, permasalahan, noWaPelapor, jidPelapor],
          );
          await connection.end();

          const tiketId = result.insertId;
          console.log(
            `[+] Tiket PENDING #${tiketId} dari ${namaPelapor} (${noWaPelapor}) berhasil dimasukkan ke DB.`,
          );

          // 5. Susun Pesan Balasan Dinamis (Bubble 1)
          const replyMessage = `✅ *REGISTRASI BERHASIL*
Terima Kasih Kak ${namaPelapor}

*ID Tiket :* ${tiketId}
👤 *Nama Pelapor :* ${namaPelapor}
📍 *Ruangan :* ${ruangan}
😘 *Permasalahan :* ${permasalahan}

*WAKTU RESPON MAKSIMAL: 30 MENIT*
Jika TEAM kami tidak merespon dalam waktu tersebut, segera hubungi:
${kontakTeamText}
_Kepuasan Anda adalah prioritas kami._`;

          // Kirim Bubble 1: Registrasi Berhasil
          await safeSend(sock, sender.chatJid, { text: replyMessage }, msg);

          // Kirim Bubble 2: Saran Tindakan Awal (Troubleshooting untuk semua laporan)
          try {
            const saranMessage = await getTroubleshootingAdvice(permasalahan);
            if (saranMessage) {
              await new Promise((resolve) => setTimeout(resolve, 600)); // jeda 600ms agar urutan rapi
              await safeSend(sock, sender.chatJid, { text: saranMessage });
            }
          } catch (saranError) {
            console.warn("⚠️ Gagal mengirim saran tindakan awal:", saranError.message);
          }

          continue; // Lanjut ke pesan berikutnya, jangan oper ke AI
        } catch (error) {
          console.error("Error saat menyimpan pelaporan:", error);
          await safeSend(
            sock,
            chatJid,
            {
              text: "❌ Terjadi kesalahan saat mencatat laporan Anda. Silakan coba lagi.",
            },
            msg,
          );
          continue;
        }
      }

      // =========================================================================
      // Fast path 3: PENYELESAIAN TIKET VIA REPLY "DONE"
      // =========================================================================
      if (/^done[!.\s]*$/i.test(textMessage.trim())) {
        const quotedContext = msg.message.extendedTextMessage?.contextInfo;
        const quotedMessageText =
          quotedContext?.quotedMessage?.conversation ||
          quotedContext?.quotedMessage?.extendedTextMessage?.text ||
          "";

        const tiketIdMatch = quotedMessageText.match(
          /ID Tiket\s*:\s*\*?\s*(\d+)/i,
        );

        if (!tiketIdMatch) {
          await safeSend(
            sock,
            chatJid,
            {
              text: "⚠️ Silakan reply/balas langsung ke pesan registrasi yang berisi *ID Tiket* dengan mengetik *Done*.",
            },
            msg,
          );
          continue;
        }

        const tiketId = tiketIdMatch[1];

        try {
          const connection = await mysql.createConnection(dbConfig);

          // Cek apakah pengirim terdaftar sebagai petugas di master PDE/Maintenance
          const [petugas] = await connection.execute(
            "SELECT id, nama_petugas FROM petugas_pde WHERE no_wa = ? OR lid = ?",
            [sender.number || "-", sender.lid || "-"],
          );

          let namaPenangan = null;
          if (petugas.length > 0) {
            namaPenangan = petugas[0].nama_petugas;

            // Simpan LID petugas jika nomor asli sudah diketahui (supaya cocok di lain waktu)
            if (sender.lid && sender.number) {
              await connection.execute(
                "UPDATE petugas_pde SET lid = ? WHERE id = ?",
                [sender.lid, petugas[0].id],
              );
            }
          }

          // Update status tiket menjadi SELESAI (bisa dilakukan oleh siapa saja, nama penangan null jika bukan tim PDE)
          const [updateResult] = await connection.execute(
            `UPDATE tikets 
             SET status = 'SELESAI', no_wa_penangan = ?, nama_penangan = ? 
             WHERE id = ? AND status = 'PENDING'`,
            [sender.number || sender.lid || null, namaPenangan, tiketId],
          );

          if (updateResult.affectedRows > 0) {
            const [tiketData] = await connection.execute(
              "SELECT no_wa_pelapor, jid_pelapor, nama_pelapor, ruangan FROM tikets WHERE id = ?",
              [tiketId],
            );

            await connection.end();

            const petugasLine = namaPenangan
              ? `\nPetugas: *${namaPenangan}*`
              : "";
            await safeSend(
              sock,
              chatJid,
              {
                text: `🎉 *TIKET #${tiketId} BERHASIL DISELESAIKAN*${petugasLine}\nStatus: *SELESAI*`,
              },
              msg,
            );

            console.log(
              `[✔] Tiket #${tiketId} di-set SELESAI via reply oleh ${namaPenangan || "Non-PDE / Umum"} (${sender.number || sender.lid || "-"})`,
            );
          } else {
            await connection.end();
            await safeSend(
              sock,
              chatJid,
              {
                text: `⚠️ Tiket dengan ID *#${tiketId}* tidak ditemukan atau sudah selesai.`,
              },
              msg,
            );
          }
        } catch (error) {
          console.error("Error saat memproses balasan done:", error);
          await safeSend(
            sock,
            chatJid,
            {
              text: "❌ Terjadi kesalahan server saat memperbarui status tiket.",
            },
            msg,
          );
        }
        continue; // Lanjut ke pesan berikutnya, jangan oper ke AI
      }

      // =========================================================================
      // DILANJUTKAN KE AI ROUTER (Jika bukan Laporan/Done/Shareloc)
      // Butuh permission !bot on per-user (default OFF)
      // =========================================================================
      if (!isBotActiveForUser(sender)) {
        // Bot AI tidak aktif untuk user ini → skip, jangan balas apa-apa
        console.log(`⏭️ Bot AI tidak aktif untuk user ${sender.number || sender.lid || sender.senderJid} di ${chatJid}, pesan diabaikan.`);
        continue;
      }

      try {
        // Tampilkan status "sedang mengetik..." di WhatsApp
        await sock.sendPresenceUpdate("composing", chatJid);

        const isExecutive =
          !!sender.number && EXECUTIVE_NUMBERS.includes(sender.number);

        // Callback untuk mengirim status terminal live ke chat WA saat query dijalankan
        const onProgress = async (terminalText) => {
          await safeSend(sock, chatJid, { text: terminalText }, msg);
        };

        let replyText = await processAiMessage(
          textMessage,
          isExecutive,
          onProgress,
        );

        if (typeof replyText === "string") {
          // Buang sisa tag function-call mentah yang lolos dari parser
          replyText = sanitizeReply(replyText);
        }

        if (
          !replyText ||
          typeof replyText !== "string" ||
          replyText.trim() === ""
        ) {
          replyText =
            "Maaf, informasi tersebut tidak ditemukan pada database SIMRS.";
        }

        await safeSend(sock, chatJid, { text: replyText }, msg);
      } catch (error) {
        console.error("Error memproses pesan:", error);
        await safeSend(
          sock,
          chatJid,
          {
            text: "Maaf, terjadi kendala saat memproses informasi data SIMRS.",
          },
          msg,
        );
      }
    }
  });
}

startBot();
