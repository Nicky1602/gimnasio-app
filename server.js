const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

const app = express();
app.use(require('cors')());
app.use(express.json());
app.use(session({
    secret: 'gimnasio123',
    resave: false,
    saveUninitialized: false
}));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL || 'postgresql://neondb_owner:npg_RnJHyrfbl3g2@ep-frosty-thunder-acws25ss.sa-east-1.aws.neon.tech/neondb?sslmode=require',
    ssl: { rejectUnauthorized: false }
});

// Crear tablas si no existen
async function initDB() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS Usuarios (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) UNIQUE NOT NULL,
            password VARCHAR(255) NOT NULL
        );
        CREATE TABLE IF NOT EXISTS Socios (
            id SERIAL PRIMARY KEY,
            nombre VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            telefono VARCHAR(20),
            fecha_registro DATE DEFAULT CURRENT_DATE,
            usuario VARCHAR(50)
        );
        CREATE TABLE IF NOT EXISTS Membresias (
            id SERIAL PRIMARY KEY,
            nombre VARCHAR(50) NOT NULL,
            precio DECIMAL(10,2) NOT NULL,
            duracion_dias INT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS Pagos (
            id SERIAL PRIMARY KEY,
            socio_id INT REFERENCES Socios(id),
            membresia_id INT REFERENCES Membresias(id),
            fecha_pago DATE DEFAULT CURRENT_DATE,
            fecha_vencimiento DATE,
            monto DECIMAL(10,2) NOT NULL,
            metodo_pago VARCHAR(20) DEFAULT 'Efectivo'
        );
        CREATE TABLE IF NOT EXISTS CierreCaja (
            id SERIAL PRIMARY KEY,
            usuario VARCHAR(50) NOT NULL,
            fecha_cierre TIMESTAMP DEFAULT NOW(),
            total_efectivo DECIMAL(10,2) DEFAULT 0,
            total_transferencia DECIMAL(10,2) DEFAULT 0,
            total_general DECIMAL(10,2) DEFAULT 0,
            observaciones VARCHAR(255)
        );
    `);
    // Usuario admin por defecto
    await pool.query(`
        INSERT INTO Usuarios (username, password) VALUES ('admin', 'admin123')
        ON CONFLICT (username) DO NOTHING;
    `);
    // Membresías por defecto
    await pool.query(`
        INSERT INTO Membresias (nombre, precio, duracion_dias) VALUES
        ('Diaria', 5.00, 1), ('Mensual', 120.00, 30), ('Anual', 1200.00, 365)
        ON CONFLICT DO NOTHING;
    `);
    console.log('Base de datos lista ✅');
}

initDB();

function auth(req, res, next) {
    if (req.session.usuario) return next();
    res.status(401).json({ error: 'No autorizado' });
}

// LOGIN
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        const r = await pool.query('SELECT * FROM Usuarios WHERE username=$1 AND password=$2', [username, password]);
        if (r.rows.length === 0) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        req.session.usuario = r.rows[0].username;
        res.json({ mensaje: 'Login exitoso', usuario: req.session.usuario });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ mensaje: 'Sesión cerrada' });
});

app.get('/api/sesion', (req, res) => {
    if (req.session.usuario) res.json({ usuario: req.session.usuario });
    else res.status(401).json({ error: 'No autenticado' });
});

app.post('/api/cambiar-password', async (req, res) => {
    const { username, passwordActual, passwordNueva } = req.body;
    try {
        const r = await pool.query('SELECT * FROM Usuarios WHERE username=$1 AND password=$2', [username, passwordActual]);
        if (r.rows.length === 0) return res.status(401).json({ error: 'Usuario o contraseña actual incorrectos' });
        await pool.query('UPDATE Usuarios SET password=$1 WHERE username=$2', [passwordNueva, username]);
        res.json({ mensaje: 'Contraseña actualizada' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// SOCIOS
app.get('/api/socios', auth, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM Socios WHERE usuario=$1 ORDER BY fecha_registro DESC', [req.session.usuario]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/socios', auth, async (req, res) => {
    const { nombre, email, telefono } = req.body;
    try {
        await pool.query('INSERT INTO Socios (nombre, email, telefono, usuario) VALUES ($1,$2,$3,$4)', [nombre, email, telefono, req.session.usuario]);
        res.json({ mensaje: 'Socio agregado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/socios/:id', auth, async (req, res) => {
    const { nombre, email, telefono } = req.body;
    try {
        await pool.query('UPDATE Socios SET nombre=$1, email=$2, telefono=$3 WHERE id=$4 AND usuario=$5', [nombre, email, telefono, req.params.id, req.session.usuario]);
        res.json({ mensaje: 'Socio actualizado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/socios/:id', auth, async (req, res) => {
    try {
        await pool.query('DELETE FROM Socios WHERE id=$1 AND usuario=$2', [req.params.id, req.session.usuario]);
        res.json({ mensaje: 'Socio eliminado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// MEMBRESÍAS
app.get('/api/membresias', auth, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM Membresias');
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/membresias', auth, async (req, res) => {
    const { nombre, precio, duracion_dias } = req.body;
    try {
        await pool.query('INSERT INTO Membresias (nombre, precio, duracion_dias) VALUES ($1,$2,$3)', [nombre, precio, duracion_dias]);
        res.json({ mensaje: 'Membresía creada' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/membresias/:id', auth, async (req, res) => {
    const { nombre, precio, duracion_dias } = req.body;
    try {
        await pool.query('UPDATE Membresias SET nombre=$1, precio=$2, duracion_dias=$3 WHERE id=$4', [nombre, precio, duracion_dias, req.params.id]);
        res.json({ mensaje: 'Membresía actualizada' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/membresias/:id', auth, async (req, res) => {
    try {
        await pool.query('DELETE FROM Membresias WHERE id=$1', [req.params.id]);
        res.json({ mensaje: 'Membresía eliminada' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// PAGOS
app.get('/api/pagos', auth, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT p.id, s.nombre as socio, m.nombre as membresia,
                   p.fecha_pago, p.fecha_vencimiento, p.monto, p.metodo_pago
            FROM Pagos p
            JOIN Socios s ON p.socio_id=s.id
            JOIN Membresias m ON p.membresia_id=m.id
            WHERE s.usuario=$1
            ORDER BY p.fecha_pago DESC`, [req.session.usuario]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pagos', auth, async (req, res) => {
    const { socio_id, membresia_id, monto, fecha_vencimiento, metodo_pago } = req.body;
    try {
        await pool.query('INSERT INTO Pagos (socio_id, membresia_id, monto, fecha_vencimiento, metodo_pago) VALUES ($1,$2,$3,$4,$5)',
            [socio_id, membresia_id, monto, fecha_vencimiento, metodo_pago]);
        res.json({ mensaje: 'Pago registrado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// CAJA
app.get('/api/caja/resumen', auth, async (req, res) => {
    try {
        const efectivo = await pool.query(`SELECT COALESCE(SUM(p.monto),0) as total FROM Pagos p JOIN Socios s ON p.socio_id=s.id WHERE s.usuario=$1 AND p.metodo_pago='Efectivo' AND p.fecha_pago=CURRENT_DATE`, [req.session.usuario]);
        const transferencia = await pool.query(`SELECT COALESCE(SUM(p.monto),0) as total FROM Pagos p JOIN Socios s ON p.socio_id=s.id WHERE s.usuario=$1 AND p.metodo_pago='Transferencia' AND p.fecha_pago=CURRENT_DATE`, [req.session.usuario]);
        const pagosHoy = await pool.query(`SELECT p.id, s.nombre as socio, m.nombre as membresia, p.monto, p.metodo_pago, p.fecha_pago, p.fecha_vencimiento FROM Pagos p JOIN Socios s ON p.socio_id=s.id JOIN Membresias m ON p.membresia_id=m.id WHERE s.usuario=$1 AND p.fecha_pago=CURRENT_DATE ORDER BY p.fecha_pago DESC`, [req.session.usuario]);
        res.json({
            efectivo: efectivo.rows[0].total,
            transferencia: transferencia.rows[0].total,
            total: parseFloat(efectivo.rows[0].total) + parseFloat(transferencia.rows[0].total),
            pagosHoy: pagosHoy.rows
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/caja/cierre', auth, async (req, res) => {
    const { observaciones } = req.body;
    try {
        const efectivo = await pool.query(`SELECT COALESCE(SUM(p.monto),0) as total FROM Pagos p JOIN Socios s ON p.socio_id=s.id WHERE s.usuario=$1 AND p.metodo_pago='Efectivo' AND p.fecha_pago=CURRENT_DATE`, [req.session.usuario]);
        const transferencia = await pool.query(`SELECT COALESCE(SUM(p.monto),0) as total FROM Pagos p JOIN Socios s ON p.socio_id=s.id WHERE s.usuario=$1 AND p.metodo_pago='Transferencia' AND p.fecha_pago=CURRENT_DATE`, [req.session.usuario]);
        const te = parseFloat(efectivo.rows[0].total);
        const tt = parseFloat(transferencia.rows[0].total);
        await pool.query('INSERT INTO CierreCaja (usuario, total_efectivo, total_transferencia, total_general, observaciones) VALUES ($1,$2,$3,$4,$5)',
            [req.session.usuario, te, tt, te+tt, observaciones]);
        res.json({ mensaje: 'Cierre realizado', totalEfectivo: te, totalTransferencia: tt, totalGeneral: te+tt });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/caja/historial', auth, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM CierreCaja WHERE usuario=$1 ORDER BY fecha_cierre DESC', [req.session.usuario]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// REPORTES
app.get('/api/reportes', auth, async (req, res) => {
    try {
        const totalSocios = await pool.query('SELECT COUNT(*) as total FROM Socios WHERE usuario=$1', [req.session.usuario]);
        const totalIngresos = await pool.query('SELECT COALESCE(SUM(p.monto),0) as total FROM Pagos p JOIN Socios s ON p.socio_id=s.id WHERE s.usuario=$1', [req.session.usuario]);
        const pagosMes = await pool.query(`SELECT COALESCE(SUM(p.monto),0) as total FROM Pagos p JOIN Socios s ON p.socio_id=s.id WHERE s.usuario=$1 AND EXTRACT(MONTH FROM p.fecha_pago)=EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM p.fecha_pago)=EXTRACT(YEAR FROM CURRENT_DATE)`, [req.session.usuario]);
        const membresiasPopulares = await pool.query(`SELECT m.nombre, COUNT(*) as cantidad FROM Pagos p JOIN Membresias m ON p.membresia_id=m.id JOIN Socios s ON p.socio_id=s.id WHERE s.usuario=$1 GROUP BY m.nombre ORDER BY cantidad DESC`, [req.session.usuario]);
        const sociosRecientes = await pool.query('SELECT nombre, email, fecha_registro FROM Socios WHERE usuario=$1 ORDER BY fecha_registro DESC LIMIT 5', [req.session.usuario]);
        res.json({
            totalSocios: totalSocios.rows[0].total,
            totalIngresos: totalIngresos.rows[0].total,
            pagosMes: pagosMes.rows[0].total,
            membresiasPopulares: membresiasPopulares.rows,
            sociosRecientes: sociosRecientes.rows
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// EXPORTAR
app.get('/api/exportar/socios/excel', auth, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM Socios WHERE usuario=$1 ORDER BY fecha_registro DESC', [req.session.usuario]);
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Socios');
        sheet.columns = [
            { header: 'ID', key: 'id', width: 8 },
            { header: 'Nombre', key: 'nombre', width: 30 },
            { header: 'Email', key: 'email', width: 30 },
            { header: 'Teléfono', key: 'telefono', width: 15 },
            { header: 'Fecha Registro', key: 'fecha_registro', width: 20 }
        ];
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE94560' } };
        r.rows.forEach(s => sheet.addRow({ ...s, fecha_registro: new Date(s.fecha_registro).toLocaleDateString('es-ES') }));
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=socios.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/exportar/socios/pdf', auth, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM Socios WHERE usuario=$1 ORDER BY fecha_registro DESC', [req.session.usuario]);
        const doc = new PDFDocument({ margin: 40 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=socios.pdf');
        doc.pipe(res);
        doc.fontSize(20).fillColor('#e94560').text('GymManager - Lista de Socios', { align: 'center' });
        doc.moveDown();
        doc.fontSize(10).fillColor('#888').text(`Generado: ${new Date().toLocaleDateString('es-ES')}`, { align: 'center' });
        doc.moveDown();
        r.rows.forEach(s => {
            doc.fontSize(11).fillColor('#333').text(`${s.nombre}   |   ${s.email}   |   ${s.telefono || '-'}   |   ${new Date(s.fecha_registro).toLocaleDateString('es-ES')}`);
            doc.moveDown(0.5);
        });
        doc.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/exportar/pagos/excel', auth, async (req, res) => {
    try {
        const r = await pool.query(`SELECT s.nombre as socio, m.nombre as membresia, p.monto, p.metodo_pago, p.fecha_pago, p.fecha_vencimiento FROM Pagos p JOIN Socios s ON p.socio_id=s.id JOIN Membresias m ON p.membresia_id=m.id WHERE s.usuario=$1 ORDER BY p.fecha_pago DESC`, [req.session.usuario]);
        const workbook = new ExcelJS.Workbook();
        const sheet = workbook.addWorksheet('Pagos');
        sheet.columns = [
            { header: 'Socio', key: 'socio', width: 30 },
            { header: 'Membresía', key: 'membresia', width: 20 },
            { header: 'Monto (S/.)', key: 'monto', width: 15 },
            { header: 'Método', key: 'metodo_pago', width: 15 },
            { header: 'Fecha Pago', key: 'fecha_pago', width: 20 },
            { header: 'Vencimiento', key: 'fecha_vencimiento', width: 20 }
        ];
        sheet.getRow(1).font = { bold: true, color: { argb: 'FFFFFFFF' } };
        sheet.getRow(1).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFE94560' } };
        r.rows.forEach(p => sheet.addRow({
            ...p,
            fecha_pago: new Date(p.fecha_pago).toLocaleDateString('es-ES'),
            fecha_vencimiento: p.fecha_vencimiento ? new Date(p.fecha_vencimiento).toLocaleDateString('es-ES') : '-'
        }));
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=pagos.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static('public'));

const server = app.listen(process.env.PORT || 3000, () => console.log('Servidor corriendo en puerto ' + (process.env.PORT || 3000)));
server.on('error', e => console.log('Error:', e.message));
process.stdin.resume();