// Katalog Struktur Skema Database SIMRS Teroptimasi untuk AI Bot
// Dirancang khusus untuk memangkas konsumsi token hingga 95% agar AI tidak cepat limit (Rate Limit / Quota Exhausted).

export const SIMRS_CORE_MODULES = [
  {
    module: "1. Pasien, Pendaftaran & Kunjungan",
    description: "Data identitas pasien, riwayat kunjungan/pendaftaran, dan pelayanan per poli/unit.",
    tables: [
      {
        name: "b_ms_pasien",
        purpose: "Master data seluruh pasien rumah sakit.",
        key_columns: ["id", "no_rm", "nama", "sex (L/P)", "alamat", "tgl_lahir", "no_id (NIK)", "no_hp", "agama", "pekerjaan_id", "alergi"],
        join_hint: "Primary key 'id' atau 'no_rm'."
      },
      {
        name: "b_kunjungan",
        purpose: "Data transaksi pendaftaran/registrasi kunjungan pasien ke RS.",
        key_columns: ["id", "no_billing", "pasien_id", "tgl (tanggal masuk)", "tgl_pulang", "pulang (cara keluar)", "kso_id (penjamin/BPJS/Umum)", "unit_id", "kelas_id", "kamar_id", "diag_awal"],
        join_hint: "Join b_ms_pasien ON b_kunjungan.pasien_id = b_ms_pasien.id"
      },
      {
        name: "b_pelayanan",
        purpose: "Rincian pelayanan/pemeriksaan unit spesifik (poli, IGD, rawat inap) pada setiap kunjungan.",
        key_columns: ["id", "kunjungan_id", "unit_id", "dokter_id", "tgl", "tgl_act (jam daftar)", "no_antrian", "dilayani"],
        join_hint: "Join b_kunjungan ON b_pelayanan.kunjungan_id = b_kunjungan.id"
      },
      {
        name: "b_antrian_px",
        purpose: "Nomor urut antrian harian pasien di poli/loket.",
        key_columns: ["id", "nama", "unit_id", "dokter_id", "no_urut (nomor antrian)", "tgl_periksa", "kunjungan_id"]
      },
      {
        name: "b_histori_pasien",
        purpose: "Log rekam jejak perpindahan status dan unit pasien.",
        key_columns: ["id", "kunjungan_id", "pelayanan_id", "pasien_id", "tgl", "petugas_id"]
      }
    ]
  },
  {
    module: "2. Dokter, Pegawai & Jadwal Praktek",
    description: "Informasi dokter, spesialisasi, staf medis, dan jadwal jaga / praktek dokter.",
    tables: [
      {
        name: "b_ms_pegawai",
        purpose: "Master data seluruh dokter, perawat, dan staf pegawai rumah sakit.",
        key_columns: ["id", "nama", "nip", "spesialisasi (gelar/spesialis)", "spesialisasi_id", "pegawai_jenis (8=dokter)", "aktif (1=aktif)", "hp (no. telp)", "no_sip"],
        join_hint: "TIDAK ADA kolom unit_id di tabel ini. 'id' → id_pegawai di b_ms_jadwal_dokter & dokter_id di b_pelayanan/b_tindakan; penempatan unit diatur lewat b_ms_jadwal_dokter.id_unit."
      },
      {
        name: "b_ms_jadwal_dokter",
        purpose: "Master jadwal praktek dokter per poliklinik dan hari.",
        key_columns: ["id", "id_pegawai", "id_unit", "hari (1=SENIN..7=MINGGU)", "jam_mulai", "jam_selesai", "tipe_dokter", "jenis_layanan", "status (1=aktif, 0=nonaktif)"],
        join_hint: "Join b_ms_pegawai ON b_ms_jadwal_dokter.id_pegawai = b_ms_pegawai.id; Join b_ms_unit ON b_ms_jadwal_dokter.id_unit = b_ms_unit.id"
      },
      {
        name: "c_ms_jadwal_dokter",
        purpose: "⭐ Jadwal praktek dokter per poli/hari — SUDAH LENGKAP (nama dokter + poli + jam + kuota menempel), TIDAK PERLU JOIN. Tabel UTAMA untuk pertanyaan jadwal dokter.",
        key_columns: ["id", "namadokter (dengan gelar, boleh NULL)", "namapoli", "namasubspesialis", "hari (1=SENIN..7=MINGGU)", "namahari ('SENIN'..'SABTU' atau 'LIBUR NASIONAL')", "jadwal (jam '07:00-12:00')", "kapasitaspasien (kuota)", "libur (0/NULL=berlaku, 1=libur)"],
        join_hint: "TIDAK PERLU JOIN. Hari memakai namahari BAHASA INDONESIA (bukan DAYNAME Inggris). Hanya SENIN-SABTU (tidak ada hari MINGGU). Contoh 'besok': WHERE namahari = CASE DAYOFWEEK(CURDATE()+INTERVAL 1 DAY) WHEN 2 THEN 'SENIN' WHEN 3 THEN 'SELASA' WHEN 4 THEN 'RABU' WHEN 5 THEN 'KAMIS' WHEN 6 THEN 'JUMAT' WHEN 7 THEN 'SABTU' ELSE 'MINGGU' END AND (libur = 0 OR libur IS NULL). Catatan: libur NULL = jadwal poli tanpa dokter spesifik (mis. GIGI) — tetap jadwal yang berlaku; namadokter boleh NULL."
      },
      {
        name: "b_ms_dokter_pengganti",
        purpose: "Data delegasi dokter pengganti saat dokter utama cuti/berhalangan.",
        key_columns: ["id", "dokter_id", "unit_id", "tgl_act1 (waktu pencatatan)"],
        join_hint: "Tabel ringkas; TIDAK ada dokter_pengganti_id/tgl_mulai/tgl_selesai — tanggal memakai tgl_act1/2/3. Join b_ms_pegawai ON b_ms_dokter_pengganti.dokter_id = b_ms_pegawai.id"
      }
    ]
  },
  {
    module: "3. Poliklinik, Unit Layanan & Wilayah",
    description: "Struktur instalasi, poliklinik rawat jalan, IGD, penunjang, dan data geografis.",
    tables: [
      {
        name: "b_ms_unit",
        purpose: "Master nama poliklinik, bangsal rawat inap, instalasi IGD, lab, farmasi, dll.",
        key_columns: ["id", "kode", "nama (nama poli/unit)", "unit_alias", "kategori", "level", "parent_id", "aktif", "kuotajkn", "kuotanonjkn"],
        join_hint: "Kolom 'id' berelasi ke unit_id di b_pelayanan, b_ms_kamar, dan antrian."
      },
      {
        name: "v_poli_aktif",
        purpose: "VIEW siap pakai berisi daftar poliklinik aktif dan kuota pendaftaran.",
        key_columns: ["id", "nama", "unit_alias", "nmpoli", "kuotajkn", "kuotanonjkn", "kdsubspesialis"]
      },
      {
        name: "b_ms_provinsi / b_ms_kota / b_ms_kecamatan / b_ms_kelurahan",
        purpose: "Master data wilayah administratif kependudukan pasien.",
        key_columns: ["id", "kode", "provinsi | kota | kecamatan | kelurahan (kolom nama menyesuaikan tabel)"],
        join_hint: "b_ms_kota.fk_ms_provinsi_id = b_ms_provinsi.id; b_ms_kecamatan.fk_ms_kota_id = b_ms_kota.id; b_ms_kelurahan.fk_ms_kecamatan_id = b_ms_kecamatan.id"
      }
    ]
  },
  {
    module: "4. Kamar, Bed & Rawat Inap",
    description: "Ketersediaan tempat tidur, kelas rawat inap, tarif kamar, dan mutasi kamar pasien.",
    tables: [
      {
        name: "b_ms_kamar",
        purpose: "Master ruangan dan kamar rawat inap.",
        key_columns: ["id", "unit_id (bangsal)", "nama (nama ruangan)", "kode", "kelas_id", "jumlah_tt (kapasitas tidur)", "jumlah_tt_b (terisi)", "aktif"],
        join_hint: "Join b_ms_unit ON b_ms_kamar.unit_id = b_ms_unit.id"
      },
      {
        name: "b_ms_bed",
        purpose: "Master tempat tidur (nomor bed) di setiap ruangan.",
        key_columns: ["id", "fk_ms_kamar_id (kamar_id)", "kode_bed", "nama_bed", "ditempati (1=terisi)", "kondisi", "is_aktif"]
      },
      {
        name: "v_info_kamar_kosong",
        purpose: "VIEW ringkas ketersediaan tempat tidur kosong per kelas dan ruangan (Sangat direkomendasikan untuk bot!).",
        key_columns: ["slide_kelas (Kelas I/II/III/VIP/VVIP)", "slide_ruang", "tt_kosong", "isi"]
      },
      {
        name: "b_reservasi_kamar",
        purpose: "Transaksi pemesanan/booking tempat tidur rawat inap.",
        key_columns: ["id", "kunjungan_id", "nama_pasien", "no_rm", "kamar_id", "bed_id", "kelas_id", "tgl_jam_pesan", "tgl_jam_ditempati", "unit_id_r"]
      },
      {
        name: "b_tindakan_kamar",
        purpose: "Transaksi pencatatan masa inap dan pemakaian tempat tidur pasien rawat inap.",
        key_columns: ["id", "pelayanan_id", "kamar_id", "bed_id", "tgl_in (masuk)", "tgl_out (keluar)", "tarip", "bayar", "lunas", "status_out"]
      }
    ]
  },
  {
    module: "5. Farmasi, Resep & Obat",
    description: "Katalog obat, penulisan resep elektronik, racikan puyer, dan rincian harga obat.",
    tables: [
      {
        name: "b_resep_obat",
        purpose: "Header lembar resep obat dari dokter untuk pasien.",
        key_columns: ["id", "no_resep", "kunjungan_id", "id_pelayanan", "pasien_id", "dokter_id", "tgl", "status", "is_lunas"],
        join_hint: "Join b_ms_pasien ON b_resep_obat.pasien_id = b_ms_pasien.id"
      },
      {
        name: "b_detail_resep_obat",
        purpose: "Rincian obat, dosis, aturan pakai, jumlah, dan harga per item resep.",
        key_columns: ["id", "b_resep_obat_id", "obat_id", "qty", "harga_satuan", "harga_total", "fk_cara_pakai", "waktu", "dosis", "lama_pemberian", "status_dilayani"],
        join_hint: "Join b_resep_obat ON b_detail_resep_obat.b_resep_obat_id = b_resep_obat.id"
      },
      {
        name: "b_puyer & b_puyer_detail",
        purpose: "Pencatatan obat racikan puyer / kapsul custom.",
        key_columns: ["id", "fk_resep (resep_id)", "nama_racikan", "jumlah", "fk_cara_pakai", "status_dilayani"],
        join_hint: "Rincian di b_puyer_detail: id, fk_puyer, fk_obat_id, jumlah. Join b_resep_obat ON b_puyer.fk_resep = b_resep_obat.id"
      },
      {
        name: "c_ms_paket_obat & c_ms_detail_paket_obat",
        purpose: "Paket standar obat untuk tindakan atau poli tertentu.",
        key_columns: ["id", "nm_paket (nama paket)", "pegawai_id"],
        join_hint: "Rincian di c_ms_detail_paket_obat: id, c_ms_paket_obat_id, obat_id, qty, harga_satuan, harga_total"
      }
    ]
  },
  {
    module: "6. Diagnosa, ICD, Tindakan Medis & Tarif",
    description: "Kode diagnosa ICD-10/ICD-9, tindakan klinis dokter, operasi, dan rincian tarif.",
    tables: [
      {
        name: "b_ms_diagnosa",
        purpose: "Master kode standar internasional ICD-10 untuk diagnosa penyakit.",
        key_columns: ["id", "kode (misal: A09, E11.9, I10)", "nama (Deskripsi Penyakit)", "level", "aktif"]
      },
      {
        name: "b_diagnosa",
        purpose: "Transaksi diagnosa penyakit yang ditegakkan dokter pada kunjungan pasien.",
        key_columns: ["diagnosa_id", "ms_diagnosa_id", "kunjungan_id", "pelayanan_id", "tgl", "primer (1=Utama, 0=Sekunder)", "uraian"],
        join_hint: "Join b_ms_diagnosa ON b_diagnosa.ms_diagnosa_id = b_ms_diagnosa.id"
      },
      {
        name: "b_ms_tindakan",
        purpose: "Master jenis tindakan medis, konsultasi, operasi, dan prosedur perawatan.",
        key_columns: ["id", "kode", "nama (nama tindakan/prosedur)", "aktif"]
      },
      {
        name: "b_ms_tindakan_kelas",
        purpose: "Tarif tindakan berdasarkan kelas rawat (Kelas 1, 2, 3, VIP, Rawat Jalan).",
        key_columns: ["id", "ms_tindakan_id", "ms_kelas_id", "kode_kelas", "tarip (tarif total)", "tarip_cito", "aktif"]
      },
      {
        name: "b_tindakan",
        purpose: "Transaksi tindakan medis yang telah diberikan kepada pasien.",
        key_columns: ["id", "kunjungan_id", "pelayanan_id", "ms_tindakan_kelas_id", "tgl", "qty (jumlah)", "biaya", "bayar", "lunas (1=lunas)"],
        join_hint: "Join b_ms_tindakan_kelas ON b_tindakan.ms_tindakan_kelas_id = b_ms_tindakan_kelas.id, lalu Join b_ms_tindakan ON b_ms_tindakan_kelas.ms_tindakan_id = b_ms_tindakan.id (tidak ada kolom tindakan_id langsung)"
      },
      {
        name: "b_detail_tindakan_pelaksana",
        purpose: "Pencatatan dokter/paramedis pelaksana yang melakukan tindakan beserta jasa medis.",
        key_columns: ["id", "tindakan_id", "pegawai_id", "ms_tenaga_medik_id"]
      }
    ]
  },
  {
    module: "7. Laboratorium, Radiologi & Diagnostik Penunjang",
    description: "Permintaan dan hasil pemeriksaan lab (darah, urine, kultur) dan radiologi (rontgen, CT scan).",
    tables: [
      {
        name: "b_ms_pemeriksaan_lab",
        purpose: "Master parameter tes laboratorium (Hb, Leukosit, Gula Darah, Kolesterol, dll).",
        key_columns: ["id", "kode", "nama", "form", "kelompok_lab_id"]
      },
      {
        name: "b_detail_permintaan_penunjang",
        purpose: "Permintaan pemeriksaan lab / radiologi dari poli/ruangan.",
        key_columns: ["id", "b_pelayanan_id", "permintaan_penunjang_pemeriksaan_id", "ms_pemeriksaan_lab_id", "status_sampel", "is_hasil", "is_ver", "tgl_hasil"]
      },
      {
        name: "b_hasil_lab",
        purpose: "Hasil angka/kualitatif tes laboratorium pasien.",
        key_columns: ["id", "id_detail_permintaan_penunjang", "id_pelayanan", "id_kunjungan", "id_pemeriksaan_lab", "hasil", "ket", "catatan", "tgl_act (waktu input)"]
      },
      {
        name: "b_ms_radiologi & b_radiologi_film",
        purpose: "Master tindakan radiologi dan log pemakaian film rontgen.",
        key_columns: ["radiologi_id (PK b_ms_radiologi — bukan 'id')", "kode", "nama_kel_rad", "level", "aktif"],
        join_hint: "b_ms_radiologi PK = radiologi_id (BUKAN 'id'). b_radiologi_film: id, pelayanan_id, jumlah_film, jenis_film, ms_ukr_film_id"
      }
    ]
  },
  {
    module: "8. Kasir, Billing & Keuangan",
    description: "Rincian kwitansi pembayaran, setoran kasir, diskon, piutang/hutang, dan kasir RS.",
    tables: [
      {
        name: "b_bayar",
        purpose: "Kwitansi header transaksi pembayaran pasien (umum / selisih biaya penjamin).",
        key_columns: ["id", "kunjungan_id", "kasir_id", "nobukti", "tgl", "dibayaroleh", "tagihan", "tagihan_obat", "nilai (total dibayar)", "diskon", "jenis_bayar", "status_byr"],
        join_hint: "Join b_kunjungan ON b_bayar.kunjungan_id = b_kunjungan.id"
      },
      {
        name: "b_bayar_tindakan",
        purpose: "Rincian pelunasan biaya per item tindakan medis.",
        key_columns: ["id", "bayar_id", "tindakan_id", "nilai"]
      },
      {
        name: "b_bayar_resep",
        purpose: "Rincian pelunasan tagihan farmasi / resep obat.",
        key_columns: ["id", "bayar_id", "resep_id", "nilai"]
      },
      {
        name: "b_setoran_kasir / b_kasir_setor",
        purpose: "Rekapitulasi setoran kasir harian ke bendahara/bank RS.",
        key_columns: ["id", "kode_setor", "tanggal", "nominal", "status", "keterangan"],
        join_hint: "Kolom di atas milik b_kasir_setor. Tabel b_setoran_kasir memakai awalan sk_: sk_id, sk_tgl, sk_nomor, sk_nilai, sk_penyetor"
      }
    ]
  },
  {
    module: "9. BPJS Kesehatan, Mobile JKN & Penjamin (KSO)",
    description: "Integrasi Surat Eligibilitas Peserta (SEP), antrian online Mobile JKN, dan klaim asuransi.",
    tables: [
      {
        name: "jkn_mobile_antrian",
        purpose: "Antrian online pasien dari aplikasi Mobile JKN BPJS.",
        key_columns: ["id_antrian", "kodebooking", "no_antrian", "nik", "no_peserta", "nama_poli", "nama_dokter", "tgl_periksa", "jam_praktek", "estimasidilayani", "sudah_dilayani", "batal"]
      },
      {
        name: "b_sep_penjamin",
        purpose: "Data Surat Eligibilitas Peserta (SEP) BPJS Kesehatan pasien.",
        key_columns: ["id", "kunjungan_id", "pasien_id", "no_sjp (Nomor SEP)", "nomor_kartu", "tgl_sjp", "diagnosa_icd", "diagnosa_nama", "jnsrawat", "klsrawat", "total_klaim"]
      },
      {
        name: "b_ms_kso",
        purpose: "Master perusahaan / badan penjamin asuransi (BPJS, Jasa Raharja, Inhealth, Mandiri, dll).",
        key_columns: ["id", "nama (Nama Penjamin)", "kode", "aktif"]
      },
      {
        name: "t_b_spri_bpjs",
        purpose: "Surat Perintah Rawat Inap (SPRI) pasien BPJS.",
        key_columns: ["id", "pasien_id", "kunjungan_id", "noSEP (nomor SEP)", "noKartu", "dpjp", "namadpjp", "namaDokter", "namapoli", "diagnosa", "tglRencanaKontrol", "status_input"]
      }
    ]
  },
  {
    module: "10. Gizi, Nutrisi & Layanan Diet Pasien",
    description: "Pemesanan menu makanan pasien rawat inap, status gizi (IMT), dan skrining nutrisi.",
    tables: [
      {
        name: "b_pesan_makanan",
        purpose: "Transaksi pesanan makanan harian pasien rawat inap ke instalasi gizi.",
        key_columns: ["id", "kunjungan_id", "pelayanan_id", "id_sesi_makan (sesi makan)", "menu_makan", "jenis_diet_id", "jenis_makan", "tgl_pesan", "tgl_distribusi", "bed"]
      },
      {
        name: "b_skrining_gizi & b_status_gizi",
        purpose: "Pencatatan indeks massa tubuh (IMT) dan skrining resiko malnutrisi pasien.",
        key_columns: ["id", "kunjungan_id", "pelayanan_id", "status_gizi_id", "jns_skrining", "total_skor", "tanggal", "ahli_gizi"],
        join_hint: "IMT & kesimpulan gizi ada di tabel b_status_gizi: id, assessment_gizi_id, imt, kesimpulan"
      },
      {
        name: "b_ms_jenis_diet",
        purpose: "Master jenis makanan khusus / diet pasien (Diet DM, Rendah Garam, Bubur, Cair, dll).",
        key_columns: ["id", "jenis_diet (nama diet)", "kode_diet", "keterangan", "aktif"]
      }
    ]
  },
  {
    module: "11. Rekam Medis Elektronik (EMR) & Triase Klinis",
    description: "Anamnesa klinis, triase IGD (Airway, Breathing, Circulation), dan resume medis.",
    tables: [
      {
        name: "b_anamnesa_pasien",
        purpose: "Pemeriksaan tanda vital pasien (Tensi, Nadi, Suhu, Respirasi, Keluhan Utama).",
        key_columns: ["id", "kunjungan_id", "pelayanan_id", "tensi", "nadi", "temperatur", "rr (laju nafas)", "bb", "tb", "gcs", "keterangan (keluhan/hasil periksa)", "tgl"]
      },
      {
        name: "b_hasil_triage",
        purpose: "Klasifikasi kegawatdaruratan pasien IGD (Merah / Kuning / Hijau / Hitam).",
        key_columns: ["id", "kunjungan_id", "pelayanan_id", "ms_warna_triage_id (warna triage)", "tanggal", "jam_datang", "jam_dilayani", "kondisi_pasien", "tipe_igd"]
      },
      {
        name: "b_riwayat_penyakit_dan_pemeriksaan_fisik",
        purpose: "Catatan riwayat penyakit terdahulu, riwayat alergi, dan pemeriksaan fisik dokter.",
        key_columns: ["id", "kunjungan_id", "pelayanan_id", "tanggal", "keluhan_utama", "penyakit_yang_pernah_diderita (riwayat penyakit)", "alergi_obat", "alergi_makanan", "kesimpulan"]
      }
    ]
  }
];

// Helper untuk menghasilkan prompt context skema yang sangat ringkas dan efisien
export function getOptimizedSchemaSummary() {
  let summary = "RINGKASAN STRUKTUR MODUL DATABASE SIMRS (Gunakan tabel berikut untuk query SELECT):\n\n";
  for (const mod of SIMRS_CORE_MODULES) {
    summary += `📁 [${mod.module}]\n`;
    for (const tbl of mod.tables) {
      summary += `  • Tabel \`${tbl.name}\`: ${tbl.purpose}\n`;
      summary += `    Kolom Kunci: ${tbl.key_columns.join(", ")}\n`;
      if (tbl.join_hint) {
        summary += `    Relasi: ${tbl.join_hint}\n`;
      }
    }
    summary += "\n";
  }
  return summary;
}
