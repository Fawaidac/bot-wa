# 📚 Panduan & Pemetaan Lengkap Database SIMRS (Database Schema Mapping)

Dokumen ini berisi hasil analisis dan pemetaan seluruh tabel pada database SIMRS (413 tabel & 4.735 kolom). Pemetaan ini dirancang khusus untuk mempermudah AI memahami struktur database secara instan, akurat, dan **sangat hemat token (mencegah limit / quota exhausted)**.

---

## 🎯 Mengapa AI Sebelumnya Cepat Limit & Lambat?

1. **Overhead Skema Terlalu Besar (64.400+ Karakter / ~16.000 Token per Request)**:
   - Sebelumnya, bot menyuntikkan seluruh 413 nama tabel dan ribuan kolom ke dalam `systemInstruction` setiap kali ada pesan masuk.
   - Akibatnya, 2 pesan WhatsApp saja sudah menghabiskan limit TPM (*Tokens Per Minute*) API Gratis Gemini/OpenRouter/Groq.
2. **Kekacauan Konteks AI (*Hallucination*)**:
   - AI bingung memilih antara tabel master (`b_ms_...`), tabel transaksi (`b_...`), tabel temporary (`..._temp`), tabel backup (`..._copy`), dan tabel view (`v_...`).
3. **Solusi Optimasi**:
   - Skema dipetakan ke dalam **11 Modul Fungsional Utama** dengan kolom kunci (*primary & foreign key*) dan relasi join yang jelas.
   - Bot WhatsApp kini menggunakan `db_schema_catalog.js` yang menghemat >85% token!

---

## 🏗️ Pola Naming Convention Tabel SIMRS

| Prefix Tabel | Kategori / Arti | Contoh Tabel | Keterangan |
| :--- | :--- | :--- | :--- |
| `b_ms_` | **Master Data SIMRS** | `b_ms_pasien`, `b_ms_pegawai`, `b_ms_kamar`, `b_ms_unit` | Referensi data induk rumah sakit |
| `b_` | **Data Transaksi Pelayanan & Klinis** | `b_kunjungan`, `b_pelayanan`, `b_tindakan`, `b_resep_obat` | Data riwayat pemeriksaan, pendaftaran, dan resep pasien |
| `c_ms_` | **Master Konfigurasi & Jadwal** | `c_ms_jadwal_dokter`, `c_ms_paket_obat` | Pengaturan jadwal dan menu aplikasi web |
| `t_b_` | **Transaksi Operasi & Khusus** | `t_b_spri_bpjs`, `t_b_tindakan_operasi` | Transaksi rawat inap khusus dan klaim |
| `jkn_` | **Integrasi BPJS Mobile JKN** | `jkn_mobile_antrian`, `jkn_mobile_user` | Sinkronisasi antrean online dari BPJS |
| `v_` / `bed_` | **SQL Views (Siap Pakai)** | `v_info_kamar_kosong`, `v_poli_aktif`, `bed_available_bpjs` | View agregasi yang sudah dioptimalkan dan sangat cepat di-query |
| `remun_` | **Remunerasi & Jasa Medis** | `remun_bayar`, `remun_kamar`, `remun_obat`, `remun_tindakan` | Laporan pembagian jasa dokter dan staf |

---

## 🗺️ Pemetaan Tabel per Modul Fungsional

---

### 1. 👤 Modul Pasien, Pendaftaran & Kunjungan
Modul utama untuk mengelola identitas pasien dan pencatatan kunjungan pendaftaran ke rumah sakit.

| Nama Tabel | Tipe | Fungsi & Deskripsi | Kolom Kunci / Penting | Relasi / Join |
| :--- | :--- | :--- | :--- | :--- |
| `b_ms_pasien` | Master | Data pokok seluruh pasien RS | `id`, `no_rm`, `nama`, `alamat`, `tgl_lahir`, `sex` (L/P), `no_id` (NIK), `no_hp`, `agama` | Primary Key: `id` / `no_rm` |
| `b_kunjungan` | Transaksi | Data registrasi kunjungan pasien ke RS | `id`, `no_billing`, `pasien_id`, `tgl`, `tgl_pulang`, `pulang` (cara keluar), `kso_id`, `unit_id`, `diag_awal` | `b_kunjungan.pasien_id = b_ms_pasien.id` |
| `b_pelayanan` | Transaksi | Rincian unit poli/IGD/ruang yang dituju pada kunjungan | `id`, `kunjungan_id`, `unit_id`, `dokter_id`, `tgl`, `no_antrian`, `dilayani` | `b_pelayanan.kunjungan_id = b_kunjungan.id` |
| `b_antrian_px` | Transaksi | Nomor antrian harian pasien di poli/loket | `id`, `nama`, `unit_id`, `dokter_id`, `no_urut`, `tgl_periksa`, `kunjungan_id` | `b_antrian_px.unit_id = b_ms_unit.id` |
| `b_histori_pasien` | Transaksi | Jejak riwayat mutasi / pergerakan pasien | `id`, `kunjungan_id`, `pelayanan_id`, `pasien_id`, `tgl` | `b_histori_pasien.pasien_id = b_ms_pasien.id` |

---

### 2. 👨‍⚕️ Modul Dokter, Tenaga Medis & Jadwal Praktek
Modul untuk data dokter spesialis, paramedis, dan jadwal praktek poliklinik.

| Nama Tabel | Tipe | Fungsi & Deskripsi | Kolom Kunci / Penting | Relasi / Join |
| :--- | :--- | :--- | :--- | :--- |
| `b_ms_pegawai` | Master | Data seluruh dokter, perawat, & staf RS | `id`, `nama`, `nip`, `spesialisasi`, `pegawai_jenis` (8=dokter), `aktif`, `hp` | `b_ms_pegawai.id` → `b_ms_jadwal_dokter.id_pegawai` (unit diatur via `id_unit`, BUKAN kolom `unit_id`) |
| `b_ms_jadwal_dokter` | Master | Jadwal praktek dokter spesialis di poli (butuh JOIN) | `id`, `id_pegawai`, `id_unit`, `hari` (1=Senin..7=Minggu), `jam_mulai`, `jam_selesai`, `tipe_dokter`, `status` | `id_pegawai = b_ms_pegawai.id`, `id_unit = b_ms_unit.id` |
| `c_ms_jadwal_dokter` | Master | ⭐ Jadwal dokter LENGKAP tanpa JOIN (tabel utama AI untuk tanya jadwal) | `id`, `namadokter` (dengan gelar), `namapoli`, `namasubspesialis`, `hari` (1=Senin..7=Minggu), `namahari` ('SENIN'..'SABTU'), `jadwal` (jam '07:00-12:00'), `kapasitaspasien`, `libur` (0=praktek, 1=libur) | TIDAK PERLU JOIN — semua info sudah menempel |
| `b_ms_dokter_pengganti` | Master | Pengalihan dokter cuti/berhalangan | `id`, `dokter_id`, `unit_id`, `tgl_act1` (waktu pencatatan) | `b_ms_dokter_pengganti.dokter_id = b_ms_pegawai.id` |

---

### 3. 🏥 Modul Poliklinik, Unit Layanan & Wilayah
Struktur unit operasional rumah sakit dan wilayah domisili pasien.

| Nama Tabel | Tipe | Fungsi & Deskripsi | Kolom Kunci / Penting | Relasi / Join |
| :--- | :--- | :--- | :--- | :--- |
| `b_ms_unit` | Master | Master daftar poli, ruangan, instalasi IGD, Lab, dll | `id`, `kode`, `nama`, `unit_alias`, `kategori`, `level`, `aktif`, `kuotajkn`, `kuotanonjkn` | Primary Key: `id` |
| `v_poli_aktif` | View | View ringkas daftar poli aktif & kuota antrean | `id`, `nama`, `unit_alias`, `nmpoli`, `kuotajkn`, `kuotanonjkn` | Siap SELECT langsung |
| `b_ms_provinsi` / `b_ms_kota` / `b_ms_kecamatan` / `b_ms_kelurahan` | Master | Data wilayah tempat tinggal | `id`, `kode`, kolom nama: `provinsi` / `kota` / `kecamatan` / `kelurahan` | `b_ms_kota.fk_ms_provinsi_id = b_ms_provinsi.id`, `b_ms_kecamatan.fk_ms_kota_id = b_ms_kota.id`, `b_ms_kelurahan.fk_ms_kecamatan_id = b_ms_kecamatan.id` |

---

### 4. 🛏️ Modul Kamar, Bed & Rawat Inap
Ketersediaan ruangan, kelas perawatan (Kelas 1, 2, 3, VIP, VVIP, ICU), tempat tidur, dan booking kamar.

| Nama Tabel | Tipe | Fungsi & Deskripsi | Kolom Kunci / Penting | Relasi / Join |
| :--- | :--- | :--- | :--- | :--- |
| `b_ms_kamar` | Master | Master data kamar/ruangan rawat inap | `id`, `unit_id`, `nama`, `kode`, `kelas_id`, `jumlah_tt` (kapasitas), `jumlah_tt_b` (terisi), `aktif` | `b_ms_kamar.unit_id = b_ms_unit.id` |
| `b_ms_bed` | Master | Master nomor tempat tidur di tiap kamar | `id`, `fk_ms_kamar_id`, `kode_bed`, `nama_bed`, `ditempati` (1=terisi), `kondisi`, `is_aktif` | `b_ms_bed.fk_ms_kamar_id = b_ms_kamar.id` |
| `v_info_kamar_kosong` | View | **Paling Cepat untuk Bot**: Ringkasan bed kosong per kelas | `slide_kelas`, `slide_ruang`, `tt_kosong`, `isi` | Siap SELECT langsung |
| `bed_available_bpjs` | View / Tabel | Ketersediaan bed untuk sinkronisasi BPJS | `kode_kelas`, `kapasitas`, `tersedia`, `tersediapria`, `tersediawanita` | Siap SELECT |
| `b_reservasi_kamar` | Transaksi | Pemesanan / booking kamar rawat inap | `id`, `kunjungan_id`, `nama_pasien`, `no_rm`, `kamar_id`, `bed_id`, `tgl_jam_pesan`, `tgl_jam_ditempati` | `b_reservasi_kamar.kamar_id = b_ms_kamar.id` |
| `b_tindakan_kamar` | Transaksi | Pemakaian kamar rawat inap harian pasien | `id`, `pelayanan_id`, `kamar_id`, `bed_id`, `tgl_in` (masuk), `tgl_out` (keluar), `tarip`, `lunas` | `b_tindakan_kamar.pelayanan_id = b_pelayanan.id` |

---

### 5. 💊 Modul Farmasi, Resep & Obat
Katalog obat, penulisan resep elektronik, rincian biaya obat, dan racikan puyer.

| Nama Tabel | Tipe | Fungsi & Deskripsi | Kolom Kunci / Penting | Relasi / Join |
| :--- | :--- | :--- | :--- | :--- |
| `b_resep_obat` | Transaksi | Lembar resep obat pasien dari dokter | `id`, `no_resep`, `kunjungan_id`, `pasien_id`, `dokter_id`, `tgl`, `status`, `is_lunas` | `b_resep_obat.pasien_id = b_ms_pasien.id` |
| `b_detail_resep_obat` | Transaksi | Rincian nama obat, jumlah, dosis, aturan pakai, dan harga | `id`, `b_resep_obat_id`, `obat_id`, `qty`, `harga_satuan`, `harga_total`, `fk_cara_pakai` | `b_detail_resep_obat.b_resep_obat_id = b_resep_obat.id` |
| `b_puyer` & `b_puyer_detail` | Transaksi | Rincian racikan obat puyer / kapsul | `b_puyer`: `id`, `fk_resep`, `nama_racikan`, `jumlah` | `b_puyer.fk_resep = b_resep_obat.id` |
| `b_ms_cara_pakai` & `b_ms_anjuran_pakai` | Master | Master instruksi minum obat (3x1 sesudah makan, dll) | `id`, `cara_pakai`, `nama` | Master label aturan pakai |

---

### 6. 🩺 Modul Diagnosa, ICD-10, Tindakan Medis & Tarif
Pencatatan diagnosa penyakit pasien, tindakan medis dokter/perawat, operasi, dan struktur tarif.

| Nama Tabel | Tipe | Fungsi & Deskripsi | Kolom Kunci / Penting | Relasi / Join |
| :--- | :--- | :--- | :--- | :--- |
| `b_ms_diagnosa` | Master | Master kode standar ICD-10 internasional | `id`, `kode` (e.g. A09, I10), `nama` (Deskripsi Penyakit), `aktif` | Primary Key: `id` |
| `b_diagnosa` | Transaksi | Diagnosa penyakit pasien pada kunjungan | `diagnosa_id`, `ms_diagnosa_id`, `kunjungan_id`, `tgl`, `primer` (1=Utama, 0=Sekunder) | `b_diagnosa.ms_diagnosa_id = b_ms_diagnosa.id` |
| `b_ms_tindakan` | Master | Master jenis tindakan, konsultasi & operasi | `id`, `kode`, `nama`, `aktif` | Primary Key: `id` |
| `b_ms_tindakan_kelas` | Master | Master tarif tindakan berdasarkan kelas rawat | `id`, `ms_tindakan_id`, `ms_kelas_id`, `tarip`, `tarip_cito`, `aktif` | `b_ms_tindakan_kelas.ms_tindakan_id = b_ms_tindakan.id` |
| `b_tindakan` | Transaksi | Transaksi tindakan yang dilakukan pada pasien | `id`, `kunjungan_id`, `pelayanan_id`, `ms_tindakan_kelas_id`, `tgl`, `qty`, `biaya`, `lunas` | `b_tindakan.ms_tindakan_kelas_id = b_ms_tindakan_kelas.id` → `b_ms_tindakan` |
| `b_detail_tindakan_pelaksana` | Transaksi | Dokter / petugas pelaksana tindakan | `id`, `tindakan_id`, `pegawai_id`, `ms_tenaga_medik_id` | `b_detail_tindakan_pelaksana.tindakan_id = b_tindakan.id` |

---

### 7. 🔬 Modul Laboratorium, Radiologi & Penunjang Medis
Pemeriksaan darah, urine, kultur mikrobiologi, rontgen, dan hasil laboratorium.

| Nama Tabel | Tipe | Fungsi & Deskripsi | Kolom Kunci / Penting | Relasi / Join |
| :--- | :--- | :--- | :--- | :--- |
| `b_ms_pemeriksaan_lab` | Master | Master tes lab (Darah Lengkap, Gula, Kolesterol, dll) | `id`, `kode`, `nama`, `form`, `kelompok_lab_id` | Primary Key: `id` |
| `b_detail_permintaan_penunjang` | Transaksi | Order permintaan lab / radiologi dari ruangan/poli | `id`, `b_pelayanan_id`, `ms_pemeriksaan_lab_id`, `permintaan_penunjang_pemeriksaan_id`, `status_sampel`, `is_hasil`, `is_ver` | `b_detail_permintaan_penunjang.b_pelayanan_id = b_pelayanan.id` |
| `b_hasil_lab` | Transaksi | Hasil pemeriksaan laboratorium pasien | `id`, `id_detail_permintaan_penunjang`, `id_pelayanan`, `id_kunjungan`, `id_pemeriksaan_lab`, `hasil`, `ket`, `catatan`, `tgl_act` | `b_hasil_lab.id_detail_permintaan_penunjang = b_detail_permintaan_penunjang.id` |
| `b_ms_radiologi` & `b_radiologi_film` | Master/Tx | Master pemeriksaan radiologi & pemakaian film | `b_ms_radiologi`: `radiologi_id` (PK, bukan `id`), `kode`, `nama_kel_rad`, `aktif`; `b_radiologi_film`: `id`, `pelayanan_id`, `jumlah_film`, `jenis_film` | Data tindakan radiologi |

---

### 8. 💳 Modul BPJS Kesehatan, Mobile JKN & Penjamin Asuransi (KSO)
Sinkronisasi antrean Mobile JKN, Surat Eligibilitas Peserta (SEP), dan klaim asuransi.

| Nama Tabel | Tipe | Fungsi & Deskripsi | Kolom Kunci / Penting | Relasi / Join |
| :--- | :--- | :--- | :--- | :--- |
| `jkn_mobile_antrian` | Transaksi | Antrian online pasien via aplikasi Mobile JKN BPJS | `id_antrian`, `kodebooking`, `no_antrian`, `nik`, `nama_poli`, `nama_dokter`, `tgl_periksa`, `sudah_dilayani` | Data antrean BPJS |
| `b_sep_penjamin` | Transaksi | Data Surat Eligibilitas Peserta (SEP) BPJS pasien | `id`, `kunjungan_id`, `pasien_id`, `no_sjp` (No SEP), `nomor_kartu`, `diagnosa_icd`, `total_klaim` | `b_sep_penjamin.kunjungan_id = b_kunjungan.id` |
| `b_ms_kso` | Master | Master instansi/asuransi penjamin (BPJS, Jasa Raharja, dll) | `id`, `nama`, `kode`, `aktif` | `b_kunjungan.kso_id = b_ms_kso.id` |
| `t_b_spri_bpjs` | Transaksi | Surat Perintah Rawat Inap (SPRI) BPJS | `id`, `noSEP`, `noKartu`, `dpjp`, `namadpjp`, `namaDokter`, `namapoli`, `diagnosa`, `tglRencanaKontrol` | Data rencana inap BPJS |

---

### 9. 💰 Modul Kasir, Billing & Keuangan
Kwitansi pembayaran, tagihan tindakan, tagihan obat, diskon, dan setoran kasir.

| Nama Tabel | Tipe | Fungsi & Deskripsi | Kolom Kunci / Penting | Relasi / Join |
| :--- | :--- | :--- | :--- | :--- |
| `b_bayar` | Transaksi | Kwitansi header transaksi pembayaran pasien | `id`, `kunjungan_id`, `kasir_id`, `nobukti`, `tgl`, `tagihan`, `tagihan_obat`, `nilai` (total bayar), `status_byr` | `b_bayar.kunjungan_id = b_kunjungan.id` |
| `b_bayar_tindakan` | Transaksi | Rincian pembayaran item tindakan | `id`, `bayar_id`, `tindakan_id`, `nilai` | `b_bayar_tindakan.bayar_id = b_bayar.id` |
| `b_bayar_resep` | Transaksi | Rincian pembayaran resep obat | `id`, `bayar_id`, `resep_id`, `nilai` | `b_bayar_resep.bayar_id = b_bayar.id` |
| `b_kasir_setor` | Transaksi | Rekap setoran kasir harian ke rekening RS | `id`, `kode_setor`, `tanggal`, `nominal`, `status` | Data pembukuan kasir |

---

### 10. 🥗 Modul Gizi, Nutrisi & Layanan Makanan
Pemesanan menu makanan pasien rawat inap, status gizi (IMT), dan diet khusus.

| Nama Tabel | Tipe | Fungsi & Deskripsi | Kolom Kunci / Penting | Relasi / Join |
| :--- | :--- | :--- | :--- | :--- |
| `b_pesan_makanan` | Transaksi | Pemesanan menu makan harian pasien inap | `id`, `kunjungan_id`, `pelayanan_id`, `id_sesi_makan`, `menu_makan`, `jenis_diet_id`, `tgl_pesan`, `bed` | `b_pesan_makanan.kunjungan_id = b_kunjungan.id` |
| `b_skrining_gizi` & `b_status_gizi` | Transaksi | Skrining nutrisi dan pengukuran IMT | `b_skrining_gizi`: `id`, `kunjungan_id`, `status_gizi_id`, `total_skor`, `tanggal`; `b_status_gizi`: `imt`, `kesimpulan` | `b_skrining_gizi.kunjungan_id = b_kunjungan.id` |
| `b_ms_jenis_diet` | Master | Master ragam diet klinis (DM, Rendah Garam, Bubur) | `id`, `jenis_diet`, `kode_diet`, `keterangan`, `aktif` | Master jenis diet |

---

### 11. 📋 Modul EMR, Anamnesa & Triase Klinis
Pemeriksaan fisik tanda-tanda vital (TTV), riwayat penyakit terdahulu, dan triase kegawatdaruratan IGD.

| Nama Tabel | Tipe | Fungsi & Deskripsi | Kolom Kunci / Penting | Relasi / Join |
| :--- | :--- | :--- | :--- | :--- |
| `b_anamnesa_pasien` | Transaksi | Tanda vital (Tensi, Nadi, Suhu, Nafas, Keluhan) | `id`, `kunjungan_id`, `pelayanan_id`, `tensi`, `nadi`, `temperatur`, `rr`, `bb`, `tb`, `gcs`, `keterangan` | `b_anamnesa_pasien.kunjungan_id = b_kunjungan.id` |
| `b_hasil_triage` | Transaksi | Triase IGD (Merah / Kuning / Hijau / Hitam) | `id`, `kunjungan_id`, `ms_warna_triage_id`, `tanggal`, `jam_datang`, `jam_dilayani`, `kondisi_pasien` | `b_hasil_triage.kunjungan_id = b_kunjungan.id` |
| `b_riwayat_penyakit_dan_pemeriksaan_fisik` | Transaksi | Riwayat penyakit, alergi, dan pemeriksaan fisik dokter | `id`, `kunjungan_id`, `tanggal`, `keluhan_utama`, `penyakit_yang_pernah_diderita`, `alergi_obat`, `alergi_makanan`, `anamnesa` | `b_riwayat_penyakit_dan_pemeriksaan_fisik.kunjungan_id = b_kunjungan.id` |

---

## ⚡ Contoh Query SQL Efisien untuk AI Bot SIMRS

```sql
-- 1. Cek Ketersediaan Kamar Rawat Inap (VIEW sangat cepat)
SELECT slide_kelas, slide_ruang, tt_kosong, isi 
FROM v_info_kamar_kosong 
WHERE tt_kosong > 0 
ORDER BY slide_kelas;

-- 2. Cek Jadwal Praktek Dokter Poliklinik (pakai c_ms_jadwal_dokter — TANPA JOIN)
SELECT namadokter, namapoli, namahari, jadwal, kapasitaspasien
FROM c_ms_jadwal_dokter
WHERE namahari = 'SENIN'
  AND (libur = 0 OR libur IS NULL)
  AND LOWER(namapoli) LIKE '%kandungan%'
LIMIT 10;

-- 3. Cek Status Antrean Pasien JKN Hari Ini
SELECT kodebooking, no_antrian, nama_poli, nama_dokter, jam_praktek, estimasidilayani, sudah_dilayani
FROM jkn_mobile_antrian
WHERE DATE(tgl_periksa) = CURDATE()
ORDER BY no_antrian ASC
LIMIT 20;

-- 4. Cek Riwayat Pelayanan Pasien Berdasarkan No RM
SELECT p.no_rm, p.nama, k.tgl AS tgl_kunjungan, u.nama AS nama_poli, peg.nama AS nama_dokter
FROM b_ms_pasien p
JOIN b_kunjungan k ON k.pasien_id = p.id
JOIN b_pelayanan pel ON pel.kunjungan_id = k.id
JOIN b_ms_unit u ON pel.unit_id = u.id
JOIN b_ms_pegawai peg ON pel.dokter_id = peg.id
WHERE p.no_rm = '123456'
ORDER BY k.tgl DESC
LIMIT 5;
```
