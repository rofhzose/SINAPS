const express = require('express');
const cors = require('cors');
const path = require('path'); // Ini yang tadi terlewat oleh sistem di baris atas
const sql = require('mssql');
const multer = require('multer');
const fs = require('fs');
const app = express();
const crypto = require('crypto');

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));

// 1. Buka akses folder 'public' agar HTML dan CSS terbaca
app.use(express.static(path.join(__dirname, 'public')));

// 2. Konfigurasi Koneksi ke MS SQL Server
const dbConfig = {
    user: 'oee',
    password: 'oee',
    server: '172.17.44.106', 
    database: 'GRWINI',
    port: 1433,
    options: { encrypt: false, trustServerCertificate: true }
};

const pool = new sql.ConnectionPool(dbConfig);
const poolConnect = pool.connect().then(() => console.log('Database Terhubung!'));

// ========================================================
// RUTE WEB UTAMA (DASHBOARD) - UPDATE TABEL BARU
// ========================================================
app.get('/api/dashboard', async (req, res) => {
    await poolConnect;
    try {
        const kpi = await pool.request().query(`
            SELECT 
                (SELECT COUNT(*) FROM patrol_findings WHERE status = 'Open') AS total_open,
                (SELECT COUNT(*) FROM patrol_findings WHERE status = 'Closed') AS total_closed,
                (SELECT COUNT(*) FROM patrol_findings) AS total_all
        `);
        
        // Tarik data untuk grafik (Section, Kategori Patrol, dan Tipe Temuan)
        const sections = await pool.request().query(`SELECT s.name, COUNT(f.id) as total FROM patrol_findings f JOIN sections s ON f.pic_section_id = s.id GROUP BY s.name`);
        const categories = await pool.request().query(`SELECT c.name, COUNT(f.id) as total FROM patrol_findings f JOIN patrol_categories c ON f.category_id = c.id GROUP BY c.name`);
        const types = await pool.request().query(`SELECT finding_type as name, COUNT(id) as total FROM patrol_findings GROUP BY finding_type`);

        res.json({ 
            status: 'success', 
            data: { 
                kpi: kpi.recordset[0], 
                charts: { sections: sections.recordset, categories: categories.recordset, types: types.recordset } 
            } 
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/finding', async (req, res) => {
    await poolConnect;
    try {
        const table = await pool.request().query(`
            SELECT f.id, f.problem_description as finding, l.name as area, f.status, c.name as patrol_name 
            FROM patrol_findings f 
            LEFT JOIN patrol_categories c ON f.category_id = c.id
            LEFT JOIN locations l ON f.location_id = l.id
            ORDER BY f.id DESC
        `);
        res.json({ status: 'success', data: table.recordset });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========================================================
// API ANDROID (PENERIMA FOTO & DATA)
// ========================================================
// Buat folder 'uploads' otomatis jika belum ada
const uploadDir = path.join(__dirname, 'public', 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

// Konfigurasi penyimpanan foto dari Android
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/uploads'); 
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Math.floor(Date.now() / 1000) + '_android_' + file.originalname;
        cb(null, uniqueSuffix);
    }
});
const upload = multer({ storage: storage });

app.post('/api/android/temuan', upload.single('photo'), async (req, res) => {
    await poolConnect;
    
    try {
        const cat_id = parseInt(req.body.category_id) || 0;
        const loc_id = parseInt(req.body.location_id) || 0;
        const finding_type = req.body.finding_type || '';
        const sec_id = parseInt(req.body.pic_section_id) || 0;
        const problem = req.body.problem_description || '';
        const due_date = req.body.due_date || '';
        const patrol_pic = req.body.patrol_pic || '';
        const date = new Date().toISOString().split('T')[0];
        const photo_path = req.file ? req.file.filename : null;

        const request = pool.request();
        request.input('cat_id', sql.Int, cat_id);
        request.input('loc_id', sql.Int, loc_id);
        request.input('finding_type', sql.VarChar, finding_type);
        request.input('sec_id', sql.Int, sec_id);
        request.input('patrol_pic', sql.VarChar, patrol_pic);
        request.input('problem', sql.VarChar, problem);
        request.input('due_date', sql.Date, due_date);
        request.input('date', sql.Date, date);
        request.input('photo', sql.VarChar, photo_path);

        const query = `
            INSERT INTO patrol_findings 
            (category_id, location_id, finding_type, pic_section_id, patrol_pic, problem_description, status, due_date, created_at, photo) 
            VALUES 
            (@cat_id, @loc_id, @finding_type, @sec_id, @patrol_pic, @problem, 'Open', @due_date, @date, @photo)
        `;

        await request.query(query);
        res.json({ status: "success", message: "Temuan berhasil dikirim dari Android!" });

    } catch (err) {
        console.error("Error API Android:", err);
        res.status(500).json({ status: "error", message: err.message });
    }
});
// ========================================================
// API UNTUK FORM WEB (Pengganti add.php)
// ========================================================

// 1. API untuk mengambil data Dropdown (Master Data)
app.get('/api/master-data', async (req, res) => {
    await poolConnect;
    try {
        const categories = await pool.request().query('SELECT id, name FROM patrol_categories ORDER BY name ASC');
        const locations = await pool.request().query('SELECT id, name FROM locations ORDER BY name ASC');
        const sections = await pool.request().query('SELECT id, name FROM sections ORDER BY name ASC');
        
        res.json({
            status: 'success',
            data: {
                categories: categories.recordset,
                locations: locations.recordset,
                sections: sections.recordset
            }
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========================================================
// TAHAP 3: LOGIKA SLA & UPDATE STATUS (Pengganti PHP lama)
// ========================================================

// 1. API Simpan Temuan (Terintegrasi dengan Logika SLA otomatis)
app.post('/api/web/temuan', upload.single('photo'), async (req, res) => {
    await poolConnect;
    try {
        const cat_id = parseInt(req.body.category_id) || 0;
        const loc_id = parseInt(req.body.location_id) || 0;
        const finding_type = req.body.finding_type || '';
        const sec_id = parseInt(req.body.pic_section_id) || 0;
        const problem = req.body.problem_description || '';
        const patrol_pic = req.body.patrol_pic || 'Admin'; 
        const date = req.body.created_at || new Date().toISOString().split('T')[0];
        const photo_path = req.file ? req.file.filename : null;

        // LOGIKA SLA: Tarik data sla_days dari tabel patrol_categories
        const catQuery = await pool.request().query(`SELECT sla_days FROM patrol_categories WHERE id = ${cat_id}`);
        let sla_days = 3; // Default 3 hari jika tidak ditemukan
        if(catQuery.recordset.length > 0) {
            sla_days = catQuery.recordset[0].sla_days;
        }
        
        // Hitung Due Date otomatis (Tanggal Pembuatan + SLA Days)
        let dueObj = new Date(date);
        dueObj.setDate(dueObj.getDate() + sla_days);
        const due_date = dueObj.toISOString().split('T')[0];

        const request = pool.request();
        const query = `
            INSERT INTO patrol_findings 
            (category_id, location_id, finding_type, pic_section_id, patrol_pic, problem_description, status, due_date, created_at, photo) 
            VALUES (${cat_id}, ${loc_id}, '${finding_type}', ${sec_id}, '${patrol_pic}', '${problem}', 'Open', '${due_date}', '${date}', ${photo_path ? `'${photo_path}'` : 'NULL'})
        `;
        await request.query(query);
        res.json({ status: "success", message: "Temuan berhasil disimpan dengan SLA " + sla_days + " hari!" });
    } catch (err) { res.status(500).json({ status: "error", message: err.message }); }
});

// 2. API Update Due Date (Pengganti update_due_date.php)
app.post('/api/web/update-due-date', async (req, res) => {
    await poolConnect;
    try {
        const id = parseInt(req.body.id);
        const due_date = req.body.due_date;
        await pool.request().query(`UPDATE patrol_findings SET due_date = '${due_date}' WHERE id = ${id}`);
        res.json({ status: "success", message: "Batas waktu (Due date) berhasil diubah!" });
    } catch (err) { res.status(500).json({ status: "error", message: err.message }); }
});

// 3. API Update Status (Pengganti update_status.php)
app.post('/api/web/update-status', async (req, res) => {
    await poolConnect;
    try {
        const id = parseInt(req.body.id);
        const status = req.body.status;
        
        // Logika reset tanggal jika status dikembalikan menjadi 'Open'
        let query = `UPDATE patrol_findings SET status = '${status}' WHERE id = ${id}`;
        if (status === 'Open') {
            query = `UPDATE patrol_findings SET status = 'Open', finish_date = NULL, recheck_date = NULL WHERE id = ${id}`;
        }
        
        await pool.request().query(query);
        res.json({ status: "success", message: `Status berhasil diubah menjadi ${status}!` });
    } catch (err) { res.status(500).json({ status: "error", message: err.message }); }
});
// 3. API untuk menyimpan Kaizen dari Web (Bisa terima 2 foto sekaligus)
app.post('/api/web/kaizen', upload.fields([{ name: 'photo_before', maxCount: 1 }, { name: 'photo_after', maxCount: 1 }]), async (req, res) => {
    await poolConnect;
    try {
        const source = req.body.source || '';
        const title = req.body.title || '';
        const sec_id = parseInt(req.body.kaizen_section_id) || 0;
        const cond_before = req.body.condition_before || '';
        const cond_after = req.body.condition_after || '';
        const date = req.body.kaizen_date || new Date().toISOString().split('T')[0];
        const status = req.body.kaizen_status || 'Open';
        const closed_date = (status === 'Closed') ? `'${date}'` : 'NULL';
        
        // Ambil nama file foto jika ada
        const photo_before = req.files['photo_before'] ? `'${req.files['photo_before'][0].filename}'` : 'NULL';
        const photo_after = req.files['photo_after'] ? `'${req.files['photo_after'][0].filename}'` : 'NULL';

        const request = pool.request();
        const query = `
            INSERT INTO other_kaizens 
            (source, title, condition_before, photo_before, condition_after, photo_after, pic_section_id, status, created_at, closed_at) 
            VALUES ('${source}', '${title}', '${cond_before}', ${photo_before}, '${cond_after}', ${photo_after}, ${sec_id}, '${status}', '${date}', ${closed_date})
        `;
        await request.query(query);
        res.json({ status: "success", message: `Kaizen ${source} berhasil disimpan!` });
    } catch (err) { res.status(500).json({ status: "error", message: err.message }); }
});

// ========================================================
// API UNTUK HALAMAN STATISTIK
// ========================================================
app.get('/api/statistik', async (req, res) => {
    await poolConnect;
    try {
        // Menerima filter tahun, jika kosong gunakan tahun saat ini
        const year = req.query.year || new Date().getFullYear();
        const request = pool.request();
        request.input('year', sql.Int, year);

        // Ambil Total Temuan & Performa Status
        const kpi = await request.query(`
            SELECT 
                COUNT(finding_id) as total_findings,
                SUM(CASE WHEN status_id = 1 THEN 1 ELSE 0 END) as tot_open,
                SUM(CASE WHEN status_id = 4 THEN 1 ELSE 0 END) as tot_closed
            FROM [dbo].[finding] 
            WHERE YEAR(finding_date) = @year
        `);

        // Ambil Jenis Temuan Terbanyak (Trending)
        const topType = await request.query(`
            SELECT TOP 1 ft.type_name as type, COUNT(f.finding_id) as total 
            FROM [dbo].[finding] f
            LEFT JOIN [dbo].[finding_type] ft ON f.finding_type_id = ft.finding_type_id
            WHERE YEAR(f.finding_date) = @year
            GROUP BY ft.type_name 
            ORDER BY total DESC
        `);

        res.json({
            status: 'success',
            data: {
                kpi: kpi.recordset[0],
                top_type: topType.recordset[0] || { type: 'Belum Ada', total: 0 }
            }
        });
    } catch (err) { 
        res.status(500).json({ error: err.message }); 
    }
});

// ========================================================
// API AKSI (SELESAIKAN & HAPUS TEMUAN)
// ========================================================

// 1. API Selesaikan Temuan (Pengganti finish.php)
app.post('/api/web/finish', upload.single('picture_after_improved'), async (req, res) => {
    await poolConnect;
    try {
        const id = parseInt(req.body.id);
        const countermeasure = req.body.countermeasure || '';
        const finish_date = req.body.finish_date || new Date().toISOString().split('T')[0];
        const photo_after = req.file ? `'${req.file.filename}'` : 'NULL';

        const query = `
            UPDATE patrol_findings 
            SET countermeasure = '${countermeasure}', 
                finish_date = '${finish_date}', 
                status = 'Closed'
                ${req.file ? `, picture_after_improved = ${photo_after}` : ''}
            WHERE id = ${id}
        `;
        await pool.request().query(query);
        res.json({ status: "success", message: "Luar biasa! Temuan berhasil diselesaikan (Closed)!" });
    } catch (err) { res.status(500).json({ status: "error", message: err.message }); }
});

// 2. API Hapus Data Fisik & Database (Pengganti delete_2.php)
app.delete('/api/web/temuan/:id', async (req, res) => {
    await poolConnect;
    try {
        const id = req.params.id;
        const check = await pool.request().query(`SELECT evidence_photo, picture_after_improved, photo FROM patrol_findings WHERE id = ${id}`);
        
        if (check.recordset.length > 0) {
            const data = check.recordset[0];
            const basePath = path.join(__dirname, 'public', 'uploads');
            
            // Hapus file fisik foto jika ada
            if (data.evidence_photo) fs.unlink(path.join(basePath, data.evidence_photo), () => {});
            if (data.picture_after_improved) fs.unlink(path.join(basePath, data.picture_after_improved), () => {});
            if (data.photo) fs.unlink(path.join(basePath, data.photo), () => {});
            
            await pool.request().query(`DELETE FROM patrol_findings WHERE id = ${id}`);
            res.json({ status: 'success', message: 'Data dan foto berhasil dihapus permanen.' });
        } else {
            res.status(404).json({ status: 'error', message: 'Data tidak ditemukan' });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// ========================================================
// API MFA DASHBOARD (DYNAMIC YEAR FILTER)
// ========================================================
app.get('/api/mfa/dashboard', async (req, res) => {
    await poolConnect;
    try {
        // Ambil semua daftar Audit untuk menu dropdown
        const auditQ = await pool.request().query(`SELECT * FROM mfa_audits ORDER BY audit_year DESC`);
        const audits = auditQ.recordset;
        
        if (audits.length === 0) return res.json({ status: "error", message: "Data Audit belum ada di database." });
        
        // Cek apakah ada request tahun spesifik, jika tidak gunakan tahun paling terbaru
        let selectedYear = req.query.year ? parseInt(req.query.year) : audits[0].audit_year;
        
        const aCurrent = audits.find(a => a.audit_year === selectedYear);
        if (!aCurrent) return res.json({ status: "error", message: `Data Audit tahun ${selectedYear} tidak ditemukan.` });

        const aPrev = audits.find(a => a.audit_year === (selectedYear - 1)); // Cari tahun sebelumnya

        // Query skor berdasarkan ID yang ditemukan
        const scoreQCurr = await pool.request().query(`SELECT * FROM mfa_pillar_scores WHERE audit_id = ${aCurrent.id}`);
        const scoreQPrev = aPrev ? await pool.request().query(`SELECT * FROM mfa_pillar_scores WHERE audit_id = ${aPrev.id}`) : { recordset: [] };
        
        const pillars = []; const score_self_curr = []; const score_mmeu_curr = []; const score_mmeu_prev = [];
        let maxDrop = 0; let dropPillar = ''; let bestGain = 0; let gainPillar = '';

        scoreQCurr.recordset.forEach(sCurr => {
            pillars.push(sCurr.pillar_name);
            score_self_curr.push(sCurr.score_self);
            score_mmeu_curr.push(sCurr.score_external);
            
            // Cari skor tahun lalu untuk pilar yang sama (jika ada)
            let pPrev = scoreQPrev.recordset.find(p => p.pillar_name === sCurr.pillar_name);
            let sPrev = pPrev ? pPrev.score_external : 0;
            score_mmeu_prev.push(sPrev);

            // Hitung Trend
            let diff = sCurr.score_external - sPrev;
            if (diff > bestGain) { bestGain = diff; gainPillar = sCurr.pillar_name; }
            if (diff < maxDrop) { maxDrop = diff; dropPillar = sCurr.pillar_name; }
        });

        // AI INSIGHT: GAP ANALYZER
        let gapPoints = aCurrent.grand_score_self - aCurrent.grand_score_mmeu;
        let aiInsight = {};
        
        if (gapPoints >= 10) {
            aiInsight = {
                title: "WARNING: OVER-SCORING DETECTED",
                desc: `Terdapat selisih signifikan (<b>${gapPoints} Poin</b>) antara Mandiri (${aCurrent.grand_score_self}) dan Aktual MMEU (${aCurrent.grand_score_mmeu}).<br><b>Kesimpulan:</b> Terindikasi standar <i>Self-Assessment</i> pabrik terlalu longgar. Auditor lokal perlu dikalibrasi ulang!`,
                color: "danger", icon: "fa-magnifying-glass-chart"
            };
        } else {
            aiInsight = {
                title: "ASSESSMENT ALIGNED",
                desc: `Penilaian Mandiri sinkron dengan hasil aktual MMEU. Pabrik menunjukkan progres. Pilar <b>${gainPillar || '-'}</b> menjadi pilar terkuat.`,
                color: "success", icon: "fa-shield-check"
            };
        }

        // Action Plan & Heatmap
        const actionQ = await pool.request().query(`
            SELECT item_no as no, pillar_name as pillar, item_name as item, status, 
            'Down' as trend, local_countermeasure as comment, 
            ISNULL(CONVERT(varchar, due_date, 23), '-') as due 
            FROM mfa_action_plans WHERE audit_id = ${aCurrent.id} ORDER BY item_no ASC
        `);
        const heatmapQ = await pool.request().query(`
            SELECT item_no, level_mmeu FROM mfa_heatmap_details WHERE audit_id = ${aCurrent.id} ORDER BY item_no ASC
        `);

        // Array daftar tahun untuk dropdown di frontend
        const availableYears = audits.map(a => a.audit_year);

        res.json({
            status: "success",
            data: {
                available_years: availableYears,
                year: aCurrent.audit_year, assessor: aCurrent.assessor_name,
                pass_current: aCurrent.actual_pass_mmeu, 
                pass_prev: aPrev ? aPrev.actual_pass_mmeu : 0, 
                target_pass: aCurrent.target_pass,
                top_pillar: gainPillar || '-', bottom_pillar: dropPillar || '-',
                pillars: pillars, 
                score_external: score_mmeu_curr, 
                score_self: score_self_curr,
                score_prev: score_mmeu_prev,
                ai_gap: aiInsight,
                action_plans: actionQ.recordset,
                heatmap_details: heatmapQ.recordset
            }
        });
    } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// ========================================================
// AI TEXT MINING & RECURRING HAZARD DETECTOR (V2 - LEBIH CERDAS)
// ========================================================
app.get('/api/ai/recurring', async (req, res) => {
    await poolConnect;
    try {
        const query = `
            SELECT f.id, f.problem_description, f.location_id, l.name as location_name, f.created_at, s.name as section_name
            FROM patrol_findings f
            LEFT JOIN locations l ON f.location_id = l.id
            LEFT JOIN sections s ON f.pic_section_id = s.id
            WHERE f.problem_description IS NOT NULL
            ORDER BY f.created_at DESC
        `;
        const result = await pool.request().query(query);
        const findings = result.recordset;

        // 1. Kamus Stopwords diperbanyak (termasuk kata gaul pabrik)
        const stopWords = ['di', 'ke', 'dari', 'yang', 'dan', 'atau', 'ini', 'itu', 'untuk', 'dengan', 'pada', 'dalam', 'mesin', 'area', 'bagian', 'ada', 'tidak', 'kurang', 'rusak', 'banyak', 'terlihat', 'karena', 'dekat', 'deket'];

        // 2. Fungsi Pembersih & BASIC STEMMER (Bocoran -> Bocor)
        const getKeywords = (text) => {
            let words = text.toLowerCase().replace(/[^a-z\s]/gi, '').split(/\s+/);
            // Potong akhiran "-an" agar kata dasarnya sama (contoh: tetesan -> tetes, bocoran -> bocor)
            words = words.map(w => w.endsWith('an') ? w.slice(0, -2) : w);
            return new Set(words.filter(w => w.length > 2 && !stopWords.includes(w)));
        };

        // 3. Ganti Jaccard dengan OVERLAP COEFFICIENT (Sangat kuat untuk kalimat beda panjang)
        const getSimilarity = (setA, setB) => {
            const intersection = new Set([...setA].filter(x => setB.has(x)));
            // Ambil ukuran kalimat yang paling pendek sebagai pembagi
            const minLength = Math.min(setA.size, setB.size);
            return minLength === 0 ? 0 : intersection.size / minLength;
        };

        let clusters = [];
        let processedIds = new Set();

        for (let i = 0; i < findings.length; i++) {
            if (processedIds.has(findings[i].id)) continue;

            let currentCluster = {
                location: findings[i].location_name,
                section: findings[i].section_name,
                base_problem: findings[i].problem_description,
                keywords: Array.from(getKeywords(findings[i].problem_description)),
                similar_cases: [],
                count: 1
            };
            processedIds.add(findings[i].id);

            const setA = getKeywords(findings[i].problem_description);

            for (let j = i + 1; j < findings.length; j++) {
                if (processedIds.has(findings[j].id)) continue;
                
                // Syarat: Lokasi Sama
                if (findings[i].location_id === findings[j].location_id) {
                    const setB = getKeywords(findings[j].problem_description);
                    const score = getSimilarity(setA, setB);
                    
                    // THRESHOLD BARU: Jika Overlap >= 40%, itu dianggap berulang!
                    if (score >= 0.40) {
                        currentCluster.similar_cases.push({
                            id: findings[j].id,
                            problem: findings[j].problem_description,
                            date: findings[j].created_at,
                            score: Math.round(score * 100)
                        });
                        currentCluster.count += 1;
                        processedIds.add(findings[j].id);
                    }
                }
            }

            if (currentCluster.count > 1) clusters.push(currentCluster);
        }

        clusters.sort((a, b) => b.count - a.count);
        res.json({ status: "success", data: clusters });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});
// ========================================================
// API ESKALASI AI KE PROYEK SGA
// ========================================================
app.post('/api/sga/escalate', async (req, res) => {
    await poolConnect;
    try {
        const title = req.body.title || '';
        const section = req.body.section || '';
        const condition_before = req.body.condition_before || '';
        const date = new Date().toISOString().split('T')[0];
        
        // Cari ID section berdasarkan nama (karena AI mengirim nama section)
        const secQuery = await pool.request().query(`SELECT id FROM sections WHERE name = '${section}'`);
        const sec_id = secQuery.recordset.length > 0 ? secQuery.recordset[0].id : 0;

        // Masukkan sebagai proyek SGA baru (Status: Open)
        const query = `
            INSERT INTO other_kaizens 
            (source, title, condition_before, pic_section_id, status, created_at) 
            VALUES ('SGA', '${title}', '${condition_before}', ${sec_id}, 'Open', '${date}')
        `;
        
        await pool.request().query(query);
        res.json({ status: "success", message: "Boom! Masalah kronis berhasil dieskalasi menjadi proyek SGA!" });
    } catch (err) {
        res.status(500).json({ status: "error", message: err.message });
    }
});

// ========================================================
// API DASHBOARD SGA & KAIZEN
// ========================================================
app.get('/api/web/kaizen-list', async (req, res) => {
    await poolConnect;
    try {
        const query = `
            SELECT k.id, k.source, k.title, k.condition_before, k.condition_after, k.status, k.created_at, k.closed_at, s.name as section_name
            FROM other_kaizens k
            LEFT JOIN sections s ON k.pic_section_id = s.id
            ORDER BY k.id DESC
        `;
        const result = await pool.request().query(query);
        const data = result.recordset;

        // Hitung KPI secara instan
        const kpi = {
            total: data.length,
            open: data.filter(d => d.status === 'Open').length,
            closed: data.filter(d => d.status === 'Closed').length
        };

        res.json({ status: 'success', kpi: kpi, data: data });
    } catch (err) { 
        res.status(500).json({ status: 'error', message: err.message }); 
    }
});

// ========================================================
// API IMPROVEMENT CONTROL TOWER (100% REAL DATA + SKT SEPARATION)
// ========================================================
app.get('/api/dept-dashboard-full', async (req, res) => {
    await poolConnect;
    try {
        const today = new Date();
        const selectedYear = parseInt(req.query.year) || today.getFullYear();
        const selectedMonth = parseInt(req.query.month) || (today.getMonth() + 1);
        const daysInMonth = new Date(selectedYear, selectedMonth, 0).getDate();
        const isCurrentMonth = (selectedYear === today.getFullYear() && selectedMonth === (today.getMonth() + 1));
        const currentDay = isCurrentMonth ? today.getDate() : daysInMonth;

        const targetList = [
            { section: 'PGA', target: 7 }, { section: 'Purchasing', target: 2 },
            { section: 'MIS', target: 4 }, { section: 'Accounting', target: 2 },
            { section: 'Sales', target: 2 }, { section: 'FG WHS & Shipping', target: 3 },
            { section: 'Improvement', target: 2 }, { section: 'QA', target: 5 },
            { section: 'QI', target: 4 }, { section: 'Packing', target: 3 },
            { section: 'PE', target: 8 }, { section: 'PPIC', target: 2 },
            { section: 'Varnish', target: 2 }, { section: 'RM WHS', target: 8 },
            { section: 'Vertical', target: 8 }, { section: 'Horizontal', target: 8 },
            { section: 'Drawing', target: 8 }, { section: 'Safety & 5S', target: 5 },
            { section: 'Dies', target: 3 }, { section: 'Machinery', target: 5 },
            { section: 'Maintenance', target: 8 }
        ];
        const targetGlobal = 200;
        const targetSKT = 101;

        // 1. Ambil Kaizen Section (Bukan SKT)
        const actualQ = await pool.request().query(`
            SELECT s.name as section, COUNT(*) as total_aktual
            FROM (
                SELECT pic_section_id, finish_date as date FROM patrol_findings WHERE is_kaizen = 'Yes' AND status = 'Closed' AND (is_skt_team = 'No' OR is_skt_team IS NULL)
                UNION ALL
                SELECT pic_section_id, closed_at as date FROM other_kaizens WHERE status = 'Closed' AND (is_skt_team = 'No' OR is_skt_team IS NULL)
            ) k
            JOIN sections s ON k.pic_section_id = s.id
            WHERE MONTH(k.date) = ${selectedMonth} AND YEAR(k.date) = ${selectedYear}
            GROUP BY s.name
        `);

        const actualMap = {};
        actualQ.recordset.forEach(r => { actualMap[r.section] = r.total_aktual; });
        
        const targetImprovements = targetList.map(t => ({
            section: t.section, target: t.target, total: actualMap[t.section] || 0
        }));

        // 2. Ambil Kaizen SKT
        const sktQ = await pool.request().query(`
            SELECT COUNT(*) as total_skt
            FROM (
                SELECT id FROM patrol_findings WHERE is_kaizen = 'Yes' AND status = 'Closed' AND is_skt_team = 'Yes' AND MONTH(finish_date) = ${selectedMonth} AND YEAR(finish_date) = ${selectedYear}
                UNION ALL
                SELECT id FROM other_kaizens WHERE status = 'Closed' AND is_skt_team = 'Yes' AND MONTH(closed_at) = ${selectedMonth} AND YEAR(closed_at) = ${selectedYear}
            ) skt_table
        `);
        
        // DEKLARASI AMAN (Mencegah Error 500)
        let cum_skt = 0, cum_200 = 0; 
        
        // 3. Data Grafik Kumulatif Harian (Real)
        let actual_skt_daily = Array(daysInMonth + 1).fill(0);
        let actual_200_daily = Array(daysInMonth + 1).fill(0);

        const qSktDaily = await pool.request().query(`
            SELECT DAY(date) as d, COUNT(*) as total FROM (
                SELECT finish_date as date FROM patrol_findings WHERE is_kaizen = 'Yes' AND status = 'Closed' AND is_skt_team = 'Yes' AND MONTH(finish_date) = ${selectedMonth} AND YEAR(finish_date) = ${selectedYear}
                UNION ALL
                SELECT closed_at as date FROM other_kaizens WHERE status = 'Closed' AND is_skt_team = 'Yes' AND MONTH(closed_at) = ${selectedMonth} AND YEAR(closed_at) = ${selectedYear}
            ) tbl GROUP BY DAY(date)
        `);
        qSktDaily.recordset.forEach(r => { if(r.d) { actual_skt_daily[r.d] = r.total; actual_200_daily[r.d] += r.total; }});
        
        const qSecDaily = await pool.request().query(`
            SELECT DAY(date) as d, COUNT(*) as total FROM (
                SELECT finish_date as date FROM patrol_findings WHERE is_kaizen = 'Yes' AND status = 'Closed' AND (is_skt_team = 'No' OR is_skt_team IS NULL) AND MONTH(finish_date) = ${selectedMonth} AND YEAR(finish_date) = ${selectedYear}
                UNION ALL
                SELECT closed_at as date FROM other_kaizens WHERE status = 'Closed' AND (is_skt_team = 'No' OR is_skt_team IS NULL) AND MONTH(closed_at) = ${selectedMonth} AND YEAR(closed_at) = ${selectedYear}
            ) tbl GROUP BY DAY(date)
        `);
        qSecDaily.recordset.forEach(r => { if(r.d) { actual_200_daily[r.d] += r.total; }});

        let chart_skt_actual = [], chart_200_actual = [], labels_days = [];
        let chart_skt_target = [], chart_200_target = [];

        for(let d = 1; d <= daysInMonth; d++) {
            labels_days.push(d);
            chart_skt_target.push(Math.round((targetSKT / daysInMonth) * d));
            chart_200_target.push(Math.round((targetGlobal / daysInMonth) * d));

            if (isCurrentMonth && d > currentDay) {
                chart_skt_actual.push(null); chart_200_actual.push(null);
            } else {
                cum_skt += actual_skt_daily[d]; cum_200 += actual_200_daily[d];
                chart_skt_actual.push(cum_skt); chart_200_actual.push(cum_200);
            }
        }

        // 4. Data Performa Departemen
        const qDeptPerf = await pool.request().query(`
            SELECT s.name as section_name,
                   SUM(CASE WHEN f.status = 'Open' AND f.is_kaizen = 'Yes' THEN 1 ELSE 0 END) as total_open,
                   SUM(CASE WHEN f.status = 'Closed' AND f.is_kaizen = 'Yes' AND MONTH(f.finish_date) = ${selectedMonth} AND YEAR(f.finish_date) = ${selectedYear} THEN 1 ELSE 0 END) as total_closed
            FROM sections s LEFT JOIN patrol_findings f ON s.id = f.pic_section_id
            GROUP BY s.name HAVING SUM(CASE WHEN f.status = 'Open' AND f.is_kaizen = 'Yes' THEN 1 ELSE 0 END) > 0 OR SUM(CASE WHEN f.status = 'Closed' AND f.is_kaizen = 'Yes' AND MONTH(f.finish_date) = ${selectedMonth} AND YEAR(f.finish_date) = ${selectedYear} THEN 1 ELSE 0 END) > 0
            ORDER BY total_open DESC, total_closed DESC
        `);

        // 5. Data Triage (Pending Approval)
        const qPending = await pool.request().query(`SELECT f.id, f.created_at, f.problem_description, s.name as section_name FROM patrol_findings f JOIN sections s ON f.pic_section_id = s.id WHERE f.is_kaizen = 'Pending' ORDER BY f.id DESC`);

        // 6. THE 3 AI INSIGHTS
        const runRate = cum_200 / (isCurrentMonth ? currentDay : daysInMonth);
        const predicted = isCurrentMonth ? Math.round(cum_200 + (runRate * (daysInMonth - currentDay))) : cum_200;
        
        const qConv = await pool.request().query(`SELECT COUNT(*) as total, SUM(CASE WHEN category_id IN (1, 2) THEN 1 ELSE 0 END) as critical, SUM(CASE WHEN category_id IN (1, 2) AND is_kaizen = 'Yes' THEN 1 ELSE 0 END) as converted FROM patrol_findings WHERE MONTH(created_at) = ${selectedMonth} AND YEAR(created_at) = ${selectedYear}`);
        const conv = qConv.recordset[0];

        const qBot = await pool.request().query(`SELECT s.name, DATEDIFF(day, f.created_at, GETDATE()) as age_days FROM patrol_findings f JOIN sections s ON f.pic_section_id = s.id WHERE f.status = 'Open' AND f.is_kaizen = 'Yes'`);
        let bottlenecks = {};
        qBot.recordset.forEach(r => {
            if (!bottlenecks[r.name]) bottlenecks[r.name] = { fresh: 0, warning: 0, chronic: 0 };
            if (r.age_days < 15) bottlenecks[r.name].fresh += 1;
            else if (r.age_days <= 30) bottlenecks[r.name].warning += 1;
            else bottlenecks[r.name].chronic += 1;
        });

        const qYears = await pool.request().query(`SELECT DISTINCT YEAR(created_at) as tahun FROM patrol_findings ORDER BY tahun DESC`);
        let availableYears = qYears.recordset.map(y => y.tahun).filter(y => y !== null);
        if (availableYears.length === 0) availableYears.push(today.getFullYear());

        res.json({
            status: "success", year: selectedYear, month: selectedMonth, availableYears: availableYears,
            data: {
                targets: targetImprovements, targetGlobal: targetGlobal, targetSKT: targetSKT,
                cum_200: cum_200, cum_skt: cum_skt,
                chartData: { labels: labels_days, actual200: chart_200_actual, target200: chart_200_target, actualSKT: chart_skt_actual, targetSKT: chart_skt_target },
                deptPerformance: qDeptPerf.recordset,
                pending: qPending.recordset,
                insights: {
                    runRate: { current: cum_200, target: targetGlobal, predicted: predicted, rate: runRate.toFixed(1) },
                    conversion: { total: conv.total || 0, critical: conv.critical || 0, converted: conv.converted || 0 },
                    bottlenecks: bottlenecks
                }
            }
        });
    } catch (err) { 
        console.error("DASHBOARD DEPT ERROR:", err); 
        res.status(500).json({ status: "error", message: err.message }); 
    }
});
// ========================================================
// API GLOBAL ANALYTICS (STATISTIK PATROL & AI FINDINGS)
// ========================================================
app.get('/api/analytics/full', async (req, res) => {
    await poolConnect;
    try {
        const selectedYear = parseInt(req.query.year) || new Date().getFullYear();
        const today = new Date();

        // 1. Ambil Daftar Tahun
        const yearsQ = await pool.request().query(`SELECT DISTINCT YEAR(created_at) as tahun FROM patrol_findings ORDER BY tahun DESC`);
        let availableYears = yearsQ.recordset.map(y => y.tahun).filter(y => y !== null);
        if (availableYears.length === 0) availableYears.push(today.getFullYear());

        // 2. Data KPI Cards (Translasi dari PHP)
        const kpiQ = await pool.request().query(`
            SELECT 
                (SELECT COUNT(id) FROM patrol_findings WHERE YEAR(created_at) = ${selectedYear}) as total_findings,
                (SELECT TOP 1 s.name FROM patrol_findings f JOIN sections s ON f.pic_section_id = s.id WHERE YEAR(f.created_at) = ${selectedYear} GROUP BY s.name ORDER BY COUNT(f.id) DESC) as top_sec_name,
                (SELECT TOP 1 COUNT(f.id) FROM patrol_findings f JOIN sections s ON f.pic_section_id = s.id WHERE YEAR(f.created_at) = ${selectedYear} GROUP BY s.name ORDER BY COUNT(f.id) DESC) as top_sec_total,
                (SELECT COUNT(id) FROM patrol_findings WHERE status = 'Open' AND YEAR(created_at) = ${selectedYear}) as tot_open,
                (SELECT COUNT(id) FROM patrol_findings WHERE status = 'Closed' AND YEAR(created_at) = ${selectedYear}) as tot_closed,
                (SELECT AVG(CAST(DATEDIFF(day, created_at, finish_date) AS FLOAT)) FROM patrol_findings WHERE status = 'Closed' AND YEAR(created_at) = ${selectedYear}) as avg_days,
                (SELECT COUNT(id) FROM patrol_findings WHERE status = 'Closed' AND finish_date <= due_date AND YEAR(created_at) = ${selectedYear}) as on_time,
                (SELECT TOP 1 ISNULL(NULLIF(finding_type, ''), 'Lainnya') FROM patrol_findings WHERE YEAR(created_at) = ${selectedYear} GROUP BY finding_type ORDER BY COUNT(id) DESC) as top_type_name,
                (SELECT TOP 1 COUNT(id) FROM patrol_findings WHERE YEAR(created_at) = ${selectedYear} GROUP BY finding_type ORDER BY COUNT(id) DESC) as top_type_total
        `);
        const kpi = kpiQ.recordset[0];

        // 3. Data Grafik & Lists
        const chart1 = await pool.request().query(`SELECT s.name as section, ISNULL(NULLIF(f.finding_type, ''), 'Lainnya') as type, COUNT(f.id) as total FROM patrol_findings f JOIN sections s ON f.pic_section_id = s.id WHERE YEAR(f.created_at) = ${selectedYear} GROUP BY s.name, finding_type`);
        const chart2 = await pool.request().query(`SELECT ISNULL(NULLIF(finding_type, ''), 'Lainnya') as type, COUNT(id) as total FROM patrol_findings WHERE YEAR(created_at) = ${selectedYear} GROUP BY finding_type`);
        const listPatrol = await pool.request().query(`SELECT TOP 5 c.name, COUNT(f.id) as total FROM patrol_findings f JOIN patrol_categories c ON f.category_id = c.id WHERE YEAR(f.created_at) = ${selectedYear} GROUP BY c.name ORDER BY total DESC`);
        const listSection = await pool.request().query(`SELECT TOP 5 s.name, COUNT(f.id) as total FROM patrol_findings f JOIN sections s ON f.pic_section_id = s.id WHERE YEAR(f.created_at) = ${selectedYear} GROUP BY s.name ORDER BY total DESC`);
        const chart3 = await pool.request().query(`SELECT c.name as category, ISNULL(NULLIF(f.finding_type, ''), 'Lainnya') as type, COUNT(f.id) as total FROM patrol_findings f JOIN patrol_categories c ON f.category_id = c.id WHERE YEAR(f.created_at) = ${selectedYear} GROUP BY c.name, finding_type`);

        // ========================================================
        // 4. THE 3 NEW FINDING INSIGHTS
        // ========================================================
        
        // INSIGHT A: SAFETY RESPONSE INDEX
        const slaQ = await pool.request().query(`
            SELECT 
                AVG(CASE WHEN finding_type IN ('Safety', 'Quality') THEN CAST(DATEDIFF(day, created_at, finish_date) AS FLOAT) ELSE NULL END) as avg_critical,
                AVG(CASE WHEN finding_type NOT IN ('Safety', 'Quality') THEN CAST(DATEDIFF(day, created_at, finish_date) AS FLOAT) ELSE NULL END) as avg_normal
            FROM patrol_findings WHERE status = 'Closed' AND YEAR(created_at) = ${selectedYear}
        `);
        const safetySLA = slaQ.recordset[0];

        // INSIGHT B: RED ZONE HOTSPOT (Area penyumbang Safety/Quality terbanyak)
        const hotspotQ = await pool.request().query(`
            SELECT TOP 1 s.name as section_name, COUNT(f.id) as total_critical 
            FROM patrol_findings f JOIN sections s ON f.pic_section_id = s.id 
            WHERE f.finding_type IN ('Safety', 'Quality') AND YEAR(f.created_at) = ${selectedYear} 
            GROUP BY s.name ORDER BY total_critical DESC
        `);
        const hotspot = hotspotQ.recordset[0] || { section_name: 'Aman', total_critical: 0 };

        // INSIGHT C: AI RECURRING DETECTOR (Menggunakan NLP Overlap Coefficient)
        const rawFindings = await pool.request().query(`SELECT id, problem_description, location_id, pic_section_id FROM patrol_findings WHERE problem_description IS NOT NULL AND YEAR(created_at) = ${selectedYear}`);
        const findings = rawFindings.recordset;
        
        const stopWords = ['di', 'ke', 'dari', 'yang', 'dan', 'atau', 'ini', 'itu', 'untuk', 'dengan', 'pada', 'dalam', 'mesin', 'area', 'bagian', 'ada', 'tidak', 'kurang', 'rusak', 'banyak', 'terlihat', 'karena', 'dekat', 'deket'];
        const getKeywords = (text) => {
            let words = text.toLowerCase().replace(/[^a-z\s]/gi, '').split(/\s+/);
            words = words.map(w => w.endsWith('an') ? w.slice(0, -2) : w);
            return new Set(words.filter(w => w.length > 2 && !stopWords.includes(w)));
        };
        const getSimilarity = (setA, setB) => {
            const intersection = new Set([...setA].filter(x => setB.has(x)));
            const minLength = Math.min(setA.size, setB.size);
            return minLength === 0 ? 0 : intersection.size / minLength;
        };

        let clusters = [];
        let processedIds = new Set();

        for (let i = 0; i < findings.length; i++) {
            if (processedIds.has(findings[i].id)) continue;
            let cluster = { problem: findings[i].problem_description, location_id: findings[i].location_id, count: 1 };
            processedIds.add(findings[i].id);
            const setA = getKeywords(findings[i].problem_description);

            for (let j = i + 1; j < findings.length; j++) {
                if (processedIds.has(findings[j].id)) continue;
                if (findings[i].location_id === findings[j].location_id) {
                    const score = getSimilarity(setA, getKeywords(findings[j].problem_description));
                    if (score >= 0.40) { cluster.count += 1; processedIds.add(findings[j].id); }
                }
            }
            if (cluster.count > 1) clusters.push(cluster);
        }
        clusters.sort((a, b) => b.count - a.count);
        const topRecurring = clusters.length > 0 ? clusters[0] : null;

        res.json({
            status: "success", year: selectedYear, availableYears: availableYears, kpi: kpi,
            charts: { c1: chart1.recordset, c2: chart2.recordset, c3: chart3.recordset },
            lists: { topPatrol: listPatrol.recordset, topSection: listSection.recordset },
            insights: {
                sla: { critical: safetySLA.avg_critical || 0, normal: safetySLA.avg_normal || 0 },
                hotspot: { name: hotspot.section_name, count: hotspot.total_critical },
                ai_recurring: topRecurring
            }
        });
    } catch (err) { res.status(500).json({ status: "error", message: err.message }); }
});

// ========================================================
// API DASHBOARD UTAMA (OPERASIONAL & PATROL)
// ========================================================
app.get('/api/dashboard-main', async (req, res) => {
    await poolConnect;
    try {
        const today = new Date().toISOString().split('T')[0];
        let whereClauses = ["1=1"];
        
        // 1. Tangkap Parameter Filter
        if (req.query.category_id) whereClauses.push(`f.category_id = ${parseInt(req.query.category_id)}`);
        if (req.query.location_id) whereClauses.push(`f.location_id = ${parseInt(req.query.location_id)}`);
        if (req.query.finding_type) whereClauses.push(`f.finding_type = '${req.query.finding_type.replace(/'/g, "''")}'`);
        
        if (req.query.status) {
            if (req.query.status === 'Overdue') {
                whereClauses.push(`f.status = 'Open' AND f.due_date < '${today}'`);
            } else {
                whereClauses.push(`f.status = '${req.query.status.replace(/'/g, "''")}'`);
            }
        }
        
        // 2. Tangkap Parameter Sorting
        let sortSql = "f.created_at DESC";
        switch (req.query.sort) {
            case 'newest': sortSql = "f.created_at DESC"; break;
            case 'oldest': sortSql = "f.created_at ASC"; break;
            case 'due_closest': sortSql = "f.due_date ASC"; break;
            case 'due_farthest': sortSql = "f.due_date DESC"; break;
            case 'overdue_first': sortSql = `CASE WHEN f.status = 'Open' AND f.due_date < '${today}' THEN 0 ELSE 1 END ASC, f.due_date ASC`; break;
        }
        
        const whereQuery = whereClauses.join(" AND ");
        
        // 3. Query KPI Cards
        const kpiQ = await pool.request().query(`
            SELECT 
                (SELECT COUNT(*) FROM patrol_findings) as total_all,
                (SELECT COUNT(*) FROM patrol_findings WHERE status='Open') as total_open,
                (SELECT COUNT(*) FROM patrol_findings WHERE status='Closed') as total_closed
        `);
        
        // 4. Query Grafik (Charts)
        const chartSec = await pool.request().query(`SELECT s.name, COUNT(f.id) as total FROM patrol_findings f JOIN sections s ON f.pic_section_id = s.id GROUP BY s.name`);
        const chartCat = await pool.request().query(`SELECT c.name, COUNT(f.id) as total FROM patrol_findings f JOIN patrol_categories c ON f.category_id = c.id GROUP BY c.name`);
        const chartType = await pool.request().query(`SELECT ISNULL(NULLIF(finding_type, ''), 'Lainnya') as name, COUNT(id) as total FROM patrol_findings GROUP BY finding_type`);
        
        // 5. Query Master Data untuk Dropdown Filter
        const cats = await pool.request().query(`SELECT * FROM patrol_categories ORDER BY name ASC`);
        const locs = await pool.request().query(`SELECT * FROM locations ORDER BY name ASC`);
        
        // 6. Query Tabel Utama
        const tableQ = await pool.request().query(`
            SELECT f.*, c.name as category_name, l.name as location_name, s.name as section_name 
            FROM patrol_findings f 
            LEFT JOIN patrol_categories c ON f.category_id = c.id
            LEFT JOIN locations l ON f.location_id = l.id
            LEFT JOIN sections s ON f.pic_section_id = s.id
            WHERE ${whereQuery}
            ORDER BY ${sortSql}
        `);
        
        res.json({
            status: 'success', today: today,
            kpi: kpiQ.recordset[0] || { total_all: 0, total_open: 0, total_closed: 0 },
            charts: { sec: chartSec.recordset, cat: chartCat.recordset, type: chartType.recordset },
            dropdowns: { categories: cats.recordset, locations: locs.recordset },
            table: tableQ.recordset
        });
    } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// ========================================================
// API MFA DASHBOARD & AI REALITY CHECK
// ========================================================
app.get('/api/mfa-dashboard', async (req, res) => {
    await poolConnect;
    try {
        const year = new Date().getFullYear();

        // 1. MOCKUP DATA MFA (Karena biasanya tabel MFA terpisah/dari Excel)
        // Jika Anda punya tabelnya, query bisa disesuaikan ke depan.
        const pillars = ['Safety & 5S', 'Quality', 'Productivity', 'Equipment', 'Human Resource'];
        const mfaScores = [85, 92, 78, 45, 88]; // Skor per pilar (Maks 100)
        const grandScore = (mfaScores.reduce((a, b) => a + b, 0) / 5).toFixed(1);

        // Generate 50 Poin Heatmap (5 Pilar x 10 Item)
        let heatmap = [];
        for(let p = 0; p < 5; p++) {
            for(let i = 1; i <= 10; i++) {
                // Simulasi nilai: Equipment (Index 3) banyak yang jelek
                let val = Math.random();
                let status = 'green';
                if (p === 3 && val > 0.3) status = 'red'; // Pilar ke-4 (Equipment) hancur
                else if (val > 0.8) status = 'yellow';
                else if (val > 0.95) status = 'red';
                
                heatmap.push({ pillar: pillars[p], item: `Point ${i}`, status: status });
            }
        }

        // 2. THE GONG! "AI REALITY CHECK" (Validasi Silang dengan Patrol)
        // Kita cek realita temuan "Equipment/Mesin" di Genba vs Skor Audit
        const realCheckQ = await pool.request().query(`
            SELECT COUNT(id) as total_problems 
            FROM patrol_findings 
            WHERE finding_type = 'Safety' OR finding_type = 'Quality' 
            AND status = 'Open' AND YEAR(created_at) = ${year}
        `);
        const genbaProblems = realCheckQ.recordset[0].total_problems || 0;

        let aiInsight = {};
        if (mfaScores[3] < 50 && genbaProblems > 10) {
            aiInsight = {
                type: 'danger', icon: 'fa-triangle-exclamation',
                title: 'AI REALITY MATCH: KRITIS PADA EQUIPMENT',
                desc: `Skor audit MFA pilar <b>Equipment</b> sangat rendah (${mfaScores[3]}%). Hal ini <b>100% tervalidasi</b> oleh realita Genba: AI mendeteksi ${genbaProblems} masalah Safety/Quality yang masih OPEN (didominasi kerusakan mesin). Fokuskan SGA bulan ini ke perbaikan mesin!`
            };
        } else if (mfaScores[0] > 80 && genbaProblems > 20) {
            // Contoh manipulasi nilai
            aiInsight = {
                type: 'warning', icon: 'fa-user-secret',
                title: 'AI DISCREPANCY DETECTED: AUDIT VS REALITA',
                desc: `Skor audit Safety & 5S dinilai tinggi (${mfaScores[0]}%), <b>NAMUN</b> AI mendeteksi ada ${genbaProblems} temuan Patrol berstatus OPEN di lapangan. <i>Terdapat potensi over-scoring (penilaian tidak objektif) pada audit MFA pilar 1.</i>`
            };
        } else {
            aiInsight = {
                type: 'success', icon: 'fa-check-double',
                title: 'AI REALITY CHECK: VALID & SINKRON',
                desc: `Skor Audit MFA berbanding lurus dengan jumlah temuan harian di Genba. Tidak terdeteksi adanya manipulasi penilaian.`
            };
        }

        res.json({
            status: "success",
            data: { 
                grandScore: grandScore, 
                radar: { labels: pillars, scores: mfaScores },
                heatmap: heatmap,
                aiCheck: aiInsight
            }
        });
    } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

// ========================================================
// API MFA DASHBOARD & AI GAP ANALYZER
// ========================================================
app.get('/api/mfa/dashboard', async (req, res) => {
    await poolConnect;
    try {
        const year = new Date().getFullYear();

        // 1. DATA AUDIT (Simulasi perbandingan Mandiri vs Eksternal)
        const pillars = ['Safety & 5S', 'Quality', 'Productivity', 'Equipment', 'Human Resource'];
        const score_self = [95, 88, 90, 85, 92];     // Penilaian Mandiri (Internal)
        const score_external = [70, 85, 75, 45, 88]; // Penilaian Eksternal MMEU
        
        const grandScore = (score_external.reduce((a, b) => a + b, 0) / 5).toFixed(1);

        // 2. AI GAP ANALYZER LOGIC
        // Cari pilar dengan kebohongan/GAP tertinggi
        let maxGap = 0;
        let gapPillar = '';
        let selfS = 0; let extS = 0;
        
        for(let i=0; i<5; i++) {
            let gap = score_self[i] - score_external[i];
            if(gap > maxGap) { maxGap = gap; gapPillar = pillars[i]; selfS = score_self[i]; extS = score_external[i]; }
        }

        // Cross-check dengan data aktual Patrol di Genba
        const realCheckQ = await pool.request().query(`SELECT COUNT(id) as total_problems FROM patrol_findings WHERE status = 'Open' AND YEAR(created_at) = ${year}`);
        const genbaProblems = realCheckQ.recordset[0].total_problems || 25; // Simulasi 25 masalah open

        let aiConclusion = {};
        if (maxGap > 15) {
            if (genbaProblems > 15) {
                // Skenario: Nilai Mandiri Tinggi, Eksternal Jelek, Lapangan Hancur
                aiConclusion = {
                    title: "FAKE COMPLIANCE DETECTED",
                    desc: `Terdeteksi GAP Ekstrem (<b>${maxGap} Poin</b>) pada pilar <b>${gapPillar}</b> (Self: ${selfS}, Ext: ${extS}).<br><br><b>Analisis Genba:</b> Ditemukan ${genbaProblems} masalah yang masih Open di lapangan. <b>Kesimpulan:</b> Indikasi kuat pengisian Checksheet Mandiri hanya formalitas (Pencil-Whipping). Komitmen aktual lemah!`,
                    color: "danger", icon: "fa-user-secret"
                };
            } else {
                // Skenario: Nilai Mandiri Tinggi, Eksternal Jelek, Lapangan Bagus
                aiConclusion = {
                    title: "DOCUMENTATION DEFICIT",
                    desc: `Terdeteksi GAP (<b>${maxGap} Poin</b>) pada pilar <b>${gapPillar}</b>.<br><br><b>Analisis Genba:</b> Kondisi aktual lapangan sangat baik (Temuan Open minim). <b>Kesimpulan:</b> Pabrik gagal di Audit Eksternal murni karena kelemahan SOP, History Record, atau Standarisasi Dokumen.`,
                    color: "warning", icon: "fa-file-circle-xmark"
                };
            }
        } else {
            aiConclusion = { title: "AUDIT ALIGNED", desc: "Penilaian Mandiri dan Eksternal sinkron. Integritas data terjaga dengan baik.", color: "success", icon: "fa-shield-check" };
        }

        // 3. ACTION PLAN & HEATMAP (Simulasi)
        const actionPlans = [
            { no: 1, pillar: 'Equipment', item: 'Abnormality Response', trend: 'Down', status: 'Open', comment: 'Mesin X sering bocor oli, tidak ada standar pembersihan', due: '2026-10-15' },
            { no: 2, pillar: 'Safety & 5S', item: 'S-T-O-P Campaign', trend: 'Up', status: 'Closed', comment: 'Rambu STOP sudah terpasang di semua titik', due: '-' }
        ];

        res.json({
            status: "success",
            data: {
                year: year, assessor: 'MMEU Japan HQ',
                score_external: grandScore,
                radar: { pillars: pillars, self: score_self, external: score_external },
                ai_gap: aiConclusion,
                action_plans: actionPlans
            }
        });
    } catch (err) { res.status(500).json({ status: 'error', message: err.message }); }
});

const http = require("http"); // Modul bawaan Node.js, tidak perlu npm install

// Rute untuk ditarik oleh Dashboard Frontend Bapak
app.get("/api/dashboard-4m/:year", (req, res) => {
  const year = req.params.year;
  const aiUrl = `http://127.0.0.1:8123/api/4m/summary/${year}`;

  // Node.js bertamu ke server Python (AI)
  http.get(aiUrl, (aiRes) => {
    let rawData = "";
    
    // Menerima data sepotong demi sepotong
    aiRes.on("data", (chunk) => { rawData += chunk; });
    
    // Jika data sudah selesai dikirim semua
    aiRes.on("end", () => {
      try {
        const parsedData = JSON.parse(rawData);
        res.json(parsedData); // Teruskan data ke frontend / browser
      } catch (e) {
        res.status(500).json({ error: "Gagal memproses data dari AI" });
      }
    });
  }).on("error", (err) => {
    console.error("AI Server Error:", err.message);
    res.status(500).json({ error: "AI Server sedang offline / tidak merespons" });
  });
});

// Endpoint untuk menarik ringkasan Blind Spot (Gap vs Confidence AI)
app.get("/api/mfa/blindspots/:year", async (req, res) => {
    try {
      const year = req.params.year;
      
      // Query menarik poin dengan overconfidence (mandiri > MMEU)
      // dan confidence AI tinggi (>= 40%)
      const query = `
        SELECT 
          d.item_no,
          d.pillar_name,
          d.item_desc,
          d.level_mandiri,
          d.level_mmeu,
          (d.level_mandiri - d.level_mmeu) AS gap_score,
          d.category_4m,
          d.confidence_4m,
          d.comment_indo
        FROM mfa_heatmap_details d
        JOIN mfa_audits a ON d.audit_id = a.id
        WHERE a.audit_year = @yearParam    /* <-- INI YANG DIPERBAIKI */
          AND d.level_mandiri > d.level_mmeu
          AND d.confidence_4m >= 40.0
        ORDER BY (d.level_mandiri - d.level_mmeu) DESC, d.confidence_4m DESC;
      `;
  
      await poolConnect; // Memastikan koneksi database sudah siap
    const request = pool.request(); // Menggunakan jalur koneksi (pool) yang sudah ada
    request.input("yearParam", sql.Int, parseInt(year));
      const result = await request.query(query);
  
      const items = result.recordset;
  
      // Kalkulasi agregasi akar masalah utama
      let categoryCounts = { Man: 0, Machine: 0, Method: 0, Material: 0 };
      items.forEach(it => {
        if (categoryCounts[it.category_4m] !== undefined) {
          categoryCounts[it.category_4m]++;
        }
      });
  
      // Cari kategori yang paling sering jadi biang kerok
      let dominantCategory = "Method";
      let maxCount = 0;
      for (const [cat, cnt] of Object.entries(categoryCounts)) {
        if (cnt > maxCount) {
          maxCount = cnt;
          dominantCategory = cat;
        }
      }
  
      res.json({
        status: "success",
        total_blindspots: items.length,
        dominant_cause: dominantCategory,
        items: items
      });
    } catch (err) {
      console.error("Gagal mengambil blindspots:", err);
      res.json({ status: "error", message: err.message }); // Pastikan response tetap format JSON
    }
  });

  // ========================================================
// API UNTUK MENYIMPAN DATA INPUT 50-POINTS MFA (DARI HTML)
// ========================================================
app.post('/api/mfa/submit', async (req, res) => {
    await poolConnect;
    
    // Kita gunakan Transaction agar jika di tengah jalan ada error, 
    // datanya tidak masuk setengah-setengah (otomatis di-rollback).
    const transaction = new sql.Transaction(pool);
    
    try {
        await transaction.begin();
        const request = new sql.Request(transaction);

        const payload = req.body;
        const year = parseInt(payload.auditYear);
        const auditorName = payload.auditorName.replace(/'/g, "''"); // Keamanan dari tanda petik

        // 1. CEK ATAU BUAT HEADER AUDIT
        // Jika tahun ini sudah pernah diinput, kita pakai ID yang lama (Update)
        // Jika belum, kita buat ID baru (Insert)
        let auditId;
        const checkAudit = await request.query(`SELECT id FROM mfa_audits WHERE audit_year = ${year}`);
        
        if (checkAudit.recordset.length > 0) {
            auditId = checkAudit.recordset[0].id;
            // Bersihkan data lama di tahun ini sebelum menimpa yang baru
            await request.query(`DELETE FROM mfa_heatmap_details WHERE audit_id = ${auditId}`);
            await request.query(`DELETE FROM mfa_pillar_scores WHERE audit_id = ${auditId}`);
        } else {
            // Buat record baru
            const insertAudit = await request.query(`
                INSERT INTO mfa_audits (audit_year, assessor_name, target_pass, actual_pass_mmeu, grand_score_self, grand_score_mmeu)
                OUTPUT INSERTED.id
                VALUES (${year}, '${auditorName}', 50, 0, 0, 0)
            `);
            auditId = insertAudit.recordset[0].id;
        }

        let passMmeu = 0;
        let pillarScores = {};

        // 2. LOOPING & INSERT 50 POIN KE TABEL HEATMAP
        for (let i = 1; i <= 50; i++) {
            const pillar = payload[`pillar_${i}`];
            const title = payload[`title_${i}`] ? payload[`title_${i}`].replace(/'/g, "''") : '';
            const mandiri = parseInt(payload[`mandiri_${i}`]) || 0;
            const mmeu = parseInt(payload[`mmeu_${i}`]) || 0;
            const komentarIndo = payload[`komentar_indo_${i}`] ? payload[`komentar_indo_${i}`].replace(/'/g, "''") : '';
            const komentarJepang = payload[`komentar_jepang_${i}`] ? payload[`komentar_jepang_${i}`].replace(/'/g, "''") : '';
            if (!pillar) continue;

            // Hitung syarat lulus (MMEU >= Level 3)
            if (mmeu >= 3) passMmeu++;

            // Agregasi untuk menghitung rata-rata skor pilar
            if (!pillarScores[pillar]) {
                pillarScores[pillar] = { selfSum: 0, mmeuSum: 0, count: 0 };
            }
            // Konversi Level 1-5 ke nilai persentase (1 = 20, 5 = 100)
            pillarScores[pillar].selfSum += (mandiri * 20);
            pillarScores[pillar].mmeuSum += (mmeu * 20);
            pillarScores[pillar].count += 1;

            // Logika AI: kalau salah satu komentar terisi, minta AI analisa
            const cat4m = (komentarIndo !== '' || komentarJepang !== '') ? 'Pending AI' : '-';
            // 1. TAMBAHKAN PENANGKAP VARIABEL INI (di bawah let mandiri / mmeu):
            const preAudit = parseInt(payload[`pre_audit_${i}`]) || 0;
            const komentarPreAudit = payload[`komentar_pre_audit_${i}`] ? payload[`komentar_pre_audit_${i}`].replace(/'/g, "''") : '';

            // 2. UBAH QUERY INSERT MENJADI INI:
            await request.query(`
                INSERT INTO mfa_heatmap_details 
                (audit_id, item_no, pillar_name, item_desc, level_mandiri, level_pre_audit, level_mmeu, comment_pre_audit, comment_indo, comment_jepang, category_4m, confidence_4m)
                VALUES (${auditId}, ${i}, '${pillar}', '${title}', ${mandiri}, ${preAudit}, ${mmeu}, '${komentarPreAudit}', '${komentarIndo}', '${komentarJepang}', '${cat4m}', 0)
            `);
        }

        // 3. HITUNG RATA-RATA & INSERT KE TABEL PILLAR SCORES
        let grandSelfSum = 0;
        let grandMmeuSum = 0;
        let totalPillars = 0;

        for (const [pillarName, data] of Object.entries(pillarScores)) {
            const avgSelf = data.count > 0 ? (data.selfSum / data.count) : 0;
            const avgMmeu = data.count > 0 ? (data.mmeuSum / data.count) : 0;

            grandSelfSum += avgSelf;
            grandMmeuSum += avgMmeu;
            totalPillars++;

            await request.query(`
                INSERT INTO mfa_pillar_scores (audit_id, pillar_name, score_self, score_external)
                VALUES (${auditId}, '${pillarName}', ${Math.round(avgSelf)}, ${Math.round(avgMmeu)})
            `);
        }

        // 4. UPDATE SKOR AKHIR & JUMLAH LULUS KE HEADER AUDIT
        const grandSelf = totalPillars > 0 ? Math.round(grandSelfSum / totalPillars) : 0;
        const grandMmeu = totalPillars > 0 ? Math.round(grandMmeuSum / totalPillars) : 0;

        await request.query(`
            UPDATE mfa_audits 
            SET grand_score_self = ${grandSelf}, 
                grand_score_mmeu = ${grandMmeu},
                actual_pass_mmeu = ${passMmeu}
            WHERE id = ${auditId}
        `);

        // Selesaikan Transaksi
        await transaction.commit();

        res.json({ status: 'success', message: 'Data 50-Points MFA dan Kalkulasi Skor berhasil diselesaikan!' });

    } catch (err) {
        // Jika ada yang gagal, batalkan semua perubahan!
        await transaction.rollback();
        console.error("Gagal simpan MFA:", err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ========================================================
// API UNTUK MENARIK DATA MFA BERDASARKAN TAHUN (UNTUK FITUR EDIT)
// ========================================================
app.get('/api/mfa/audit-data', async (req, res) => {
    await poolConnect;
    try {
        const year = parseInt(req.query.year);
        if (!year) return res.json({ status: 'error', message: 'Tahun tidak valid' });

        // Cek apakah data audit untuk tahun tersebut sudah ada
        const auditQ = await pool.request().query(`SELECT id, assessor_name FROM mfa_audits WHERE audit_year = ${year}`);
        
        if (auditQ.recordset.length === 0) {
            // Belum ada data, kirim pesan agar form tetap kosong
            return res.json({ status: 'not_found', message: `Belum ada data audit untuk tahun ${year}. Silakan input sebagai data baru.` });
        }

        const auditId = auditQ.recordset[0].id;
        const auditorName = auditQ.recordset[0].assessor_name;

        // Tarik detail 50 poin dari tabel heatmap
        // UBAH QUERY INI:
        const detailsQ = await pool.request().query(`
            SELECT item_no, level_mandiri, level_pre_audit, level_mmeu, comment_pre_audit, comment_indo, comment_jepang 
            FROM mfa_heatmap_details 
            WHERE audit_id = ${auditId}
        `);
        res.json({
            status: 'success',
            data: {
                auditorName: auditorName,
                items: detailsQ.recordset
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ========================================================
// API UNTUK HALAMAN KOMPARASI / GAP ANALYSIS (MFA)
// ========================================================
app.get('/api/mfa/compare', async (req, res) => {
    await poolConnect;
    try {
        const year = parseInt(req.query.year) || 2026;
        const prevYear = year - 1;

        const currAuditQ = await pool.request().query(`SELECT id FROM mfa_audits WHERE audit_year = ${year}`);
        if (currAuditQ.recordset.length === 0) {
            return res.json({ status: 'not_found', message: `Belum ada data untuk tahun ${year}.` });
        }
        const currAuditId = currAuditQ.recordset[0].id;

        // 1. Ambil total skor Mandiri tahun lalu
        let prevMandiriTotal = 0;
        const prevAuditQ = await pool.request().query(`SELECT id FROM mfa_audits WHERE audit_year = ${prevYear}`);
        if (prevAuditQ.recordset.length > 0) {
            const prevDetails = await pool.request().query(`
                SELECT ISNULL(SUM(CASE WHEN level_mandiri >= 3 THEN level_mandiri - 1 ELSE 0 END), 0) as total 
                FROM mfa_heatmap_details WHERE audit_id = ${prevAuditQ.recordset[0].id}
            `);
            prevMandiriTotal = prevDetails.recordset[0].total;
        }

        // 2. Tarik seluruh 50 baris detail dari tahun saat ini
        const detailsQ = await pool.request().query(`
            SELECT item_no, pillar_name, item_desc, 
                   ISNULL(level_mandiri, 0) as level_mandiri, 
                   ISNULL(level_pre_audit, 0) as level_pre_audit, 
                   ISNULL(level_mmeu, 0) as level_mmeu, 
                   comment_pre_audit, comment_indo, comment_jepang,
                   
                   -- INI TAMBAHANNYA: Ambil data Tindak Lanjut
                   action_countermeasure, action_pic, action_due_date, action_status, action_photo
                   
            FROM mfa_heatmap_details 
            WHERE audit_id = ${currAuditId}
            ORDER BY item_no ASC
        `);
        const items = detailsQ.recordset;

        // 3. Kalkulasi Total dengan Rumus Baru
        let mandiriTotal = 0, preTotal = 0, mmeuTotal = 0;
        let pillarData = {};

        items.forEach(item => {
            // RUMUS BARU: Level 1 & 2 = 0. Level 3 ke atas = Level - 1
            let ptMandiri = item.level_mandiri >= 3 ? item.level_mandiri - 1 : 0;
            let ptPre = item.level_pre_audit >= 3 ? item.level_pre_audit - 1 : 0;
            let ptMmeu = item.level_mmeu >= 3 ? item.level_mmeu - 1 : 0;

            mandiriTotal += ptMandiri;
            preTotal += ptPre;
            mmeuTotal += ptMmeu;

            if (!pillarData[item.pillar_name]) {
                pillarData[item.pillar_name] = { count: 0, mandiri: 0, pre: 0, mmeu: 0 };
            }
            pillarData[item.pillar_name].count += 1;
            pillarData[item.pillar_name].mandiri += ptMandiri;
            pillarData[item.pillar_name].pre += ptPre;
            pillarData[item.pillar_name].mmeu += ptMmeu;
        });

        // 4. Konversi Poin Radar Chart ke Persen (Maks Poin = 4 per item, jadi dikali 25 agar jadi 100%)
        const radarLabels = Object.keys(pillarData);
        const radarMandiri = radarLabels.map(p => (pillarData[p].mandiri / pillarData[p].count) * 25);
        const radarPre = radarLabels.map(p => (pillarData[p].pre / pillarData[p].count) * 25);
        const radarMmeu = radarLabels.map(p => (pillarData[p].mmeu / pillarData[p].count) * 25);

        res.json({
            status: 'success',
            data: {
                items: items,
                totals: { mandiri: mandiriTotal, pre: preTotal, mmeu: mmeuTotal, prevMandiri: prevMandiriTotal },
                pillarRaw: pillarData, 
                radar: { labels: radarLabels, mandiri: radarMandiri, pre: radarPre, mmeu: radarMmeu }
            }
        });
    } catch (err) {
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ========================================================
// API SIMPAN ACTION PLAN & FOTO (BASE64)
// ========================================================
app.post('/api/mfa/action-plan', async (req, res) => {
    await poolConnect;
    try {
        const { year, item_no, countermeasure, pic, due_date, photo_base64 } = req.body;
        
        // 1. Cari ID Audit berdasarkan tahun
        const auditQ = await pool.request().query(`SELECT id FROM mfa_audits WHERE audit_year = ${year}`);
        if (auditQ.recordset.length === 0) {
            return res.json({ status: 'error', message: 'Tahun audit tidak ditemukan.' });
        }
        const auditId = auditQ.recordset[0].id;

        // 2. Simpan (Update) ke tabel mfa_heatmap_details
        // Kita menggunakan metode .input() untuk keamanan (mencegah SQL Injection dari teks gambar yang panjang)
        const sql = require('mssql'); 
        await pool.request()
            .input('audit_id', sql.Int, auditId)
            .input('item_no', sql.Int, item_no)
            .input('cm', sql.VarChar(sql.MAX), countermeasure)
            .input('pic', sql.VarChar(100), pic)
            .input('due', sql.Date, due_date)
            .input('photo', sql.VarChar(sql.MAX), photo_base64)
            .query(`
                UPDATE mfa_heatmap_details 
                SET action_countermeasure = @cm, 
                    action_pic = @pic, 
                    action_due_date = @due, 
                    action_status = 'OPEN',
                    action_photo = @photo
                WHERE audit_id = @audit_id AND item_no = @item_no
            `);

        res.json({ status: 'success', message: 'Tindak lanjut dan bukti foto berhasil diamankan!' });
    } catch (err) {
        console.error("Gagal simpan action plan:", err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});
// ========================================================
// API VALIDASI: CLOSE ACTION PLAN (IMPROVEMENT SECTION)
// ========================================================
app.post('/api/mfa/action-plan/close', async (req, res) => {
    await poolConnect;
    try {
        const { year, item_no } = req.body;

        // 1. Cari ID Audit berdasarkan tahun
        const auditQ = await pool.request().query(`SELECT id FROM mfa_audits WHERE audit_year = ${year}`);
        if (auditQ.recordset.length === 0) {
            return res.json({ status: 'error', message: 'Tahun audit tidak ditemukan.' });
        }
        const auditId = auditQ.recordset[0].id;

        // 2. Update status menjadi CLOSED
        await pool.request().query(`
            UPDATE mfa_heatmap_details 
            SET action_status = 'CLOSED'
            WHERE audit_id = ${auditId} AND item_no = ${item_no}
        `);

        res.json({ status: 'success', message: 'Tindak lanjut divalidasi dan dinyatakan CLOSED!' });
    } catch (err) {
        console.error("Gagal close action plan:", err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});
// ========================================================
// API HAPUS / RESET ACTION PLAN
// ========================================================
app.post('/api/mfa/action-plan/delete', async (req, res) => {
    await poolConnect;
    try {
        const { year, item_no } = req.body;

        // 1. Cari ID Audit berdasarkan tahun
        const auditQ = await pool.request().query(`SELECT id FROM mfa_audits WHERE audit_year = ${year}`);
        if (auditQ.recordset.length === 0) {
            return res.json({ status: 'error', message: 'Tahun audit tidak ditemukan.' });
        }
        const auditId = auditQ.recordset[0].id;

        // 2. Kosongkan data (Set ke NULL)
        await pool.request().query(`
            UPDATE mfa_heatmap_details 
            SET action_countermeasure = NULL,
                action_pic = NULL,
                action_due_date = NULL,
                action_status = 'OPEN',
                action_photo = NULL
            WHERE audit_id = ${auditId} AND item_no = ${item_no}
        `);

        res.json({ status: 'success', message: 'Data Tindak Lanjut dan Foto berhasil dihapus!' });
    } catch (err) {
        console.error("Gagal hapus action plan:", err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ========================================================
// API UNTUK HALAMAN VERIFIKASI (IMPROVEMENT SECTION)
// ========================================================
app.get('/api/mfa/verification-list', async (req, res) => {
    await poolConnect;
    try {
        const year = parseInt(req.query.year) || 2026;

        // Cari ID Audit
        const auditQ = await pool.request().query(`SELECT id FROM mfa_audits WHERE audit_year = ${year}`);
        if (auditQ.recordset.length === 0) {
            return res.json({ status: 'success', data: [] });
        }
        const auditId = auditQ.recordset[0].id;

        // Tarik HANYA baris yang Action Plan-nya TIDAK KOSONG
        const detailsQ = await pool.request().query(`
            SELECT item_no, pillar_name, item_desc, 
                   action_countermeasure, action_pic, action_due_date, action_status, action_photo,
                   ISNULL(level_mandiri, 0) as level_mandiri,
                   ISNULL(level_mmeu, 0) as level_mmeu
            FROM mfa_heatmap_details 
            WHERE audit_id = ${auditId} AND action_countermeasure IS NOT NULL
            ORDER BY action_status DESC, item_no ASC
        `);

        res.json({ status: 'success', data: detailsQ.recordset });
    } catch (err) {
        console.error("Gagal load verifikasi:", err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});

// ========================================================
// API UBAH STATUS ACTION PLAN (OPEN / CLOSED)
// ========================================================
app.post('/api/mfa/action-plan/update-status', async (req, res) => {
    await poolConnect;
    try {
        const { year, item_no, new_status } = req.body;

        // Cari ID Audit
        const auditQ = await pool.request().query(`SELECT id FROM mfa_audits WHERE audit_year = ${year}`);
        if (auditQ.recordset.length === 0) {
            return res.json({ status: 'error', message: 'Tahun audit tidak ditemukan.' });
        }
        const auditId = auditQ.recordset[0].id;

        // Update status sesuai permintaan (bisa 'OPEN' atau 'CLOSED')
        await pool.request().query(`
            UPDATE mfa_heatmap_details 
            SET action_status = '${new_status}'
            WHERE audit_id = ${auditId} AND item_no = ${item_no}
        `);

        res.json({ status: 'success', message: `Status Point #${item_no} berhasil diubah menjadi ${new_status}!` });
    } catch (err) {
        console.error("Gagal update status:", err);
        res.status(500).json({ status: 'error', message: err.message });
    }
});
app.listen(4000, () => console.log('SERVER GEMBIRA MENYALA DI PORT 4000'));