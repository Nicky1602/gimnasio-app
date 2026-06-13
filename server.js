const express = require('express');
const { Pool } = require('pg');
const session = require('express-session');
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');
const bcrypt = require('bcrypt');
const crypto = require('crypto');
const { Resend } = require('resend');
const resend = new Resend(process.env.RESEND_API_KEY);
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
        CREATE TABLE IF NOT EXISTS Gimnasios (
            id SERIAL PRIMARY KEY,
            nombre VARCHAR(100) NOT NULL,
            email VARCHAR(100) UNIQUE NOT NULL,
            codigo VARCHAR(20) UNIQUE NOT NULL,
            fecha_registro TIMESTAMP DEFAULT NOW()
        );
        CREATE TABLE IF NOT EXISTS Usuarios (
            id SERIAL PRIMARY KEY,
            username VARCHAR(50) NOT NULL,
            password VARCHAR(255) NOT NULL,
            gimnasio_id INT REFERENCES Gimnasios(id),
            UNIQUE(username, gimnasio_id)
        );
        CREATE TABLE IF NOT EXISTS Socios (
            id SERIAL PRIMARY KEY,
            nombre VARCHAR(100) NOT NULL,
            email VARCHAR(100),
            telefono VARCHAR(20),
            fecha_registro DATE DEFAULT CURRENT_DATE,
            usuario VARCHAR(50),
            gimnasio_id INT REFERENCES Gimnasios(id)
        );
        CREATE TABLE IF NOT EXISTS Membresias (
            id SERIAL PRIMARY KEY,
            nombre VARCHAR(50) NOT NULL,
            precio DECIMAL(10,2) NOT NULL,
            duracion_dias INT NOT NULL,
            gimnasio_id INT REFERENCES Gimnasios(id)
        );
        CREATE TABLE IF NOT EXISTS Pagos (
            id SERIAL PRIMARY KEY,
            socio_id INT REFERENCES Socios(id),
            membresia_id INT REFERENCES Membresias(id),
            fecha_pago DATE DEFAULT CURRENT_DATE,
            fecha_vencimiento DATE,
            monto DECIMAL(10,2) NOT NULL,
            metodo_pago VARCHAR(20) DEFAULT 'Efectivo',
            gimnasio_id INT REFERENCES Gimnasios(id)
        );
        CREATE TABLE IF NOT EXISTS CierreCaja (
            id SERIAL PRIMARY KEY,
            usuario VARCHAR(50) NOT NULL,
            fecha_cierre TIMESTAMP DEFAULT NOW(),
            total_efectivo DECIMAL(10,2) DEFAULT 0,
            total_transferencia DECIMAL(10,2) DEFAULT 0,
            total_general DECIMAL(10,2) DEFAULT 0,
            observaciones VARCHAR(255),
            gimnasio_id INT REFERENCES Gimnasios(id)
        );
    `);
    console.log('Base de datos lista ✅');
}


function auth(req, res, next) {
    if (req.session.usuario) return next();
    res.status(401).json({ error: 'No autorizado' });
}
function isAdmin(req, res, next) {
    if (req.session.rol === 'admin') return next();
    res.status(403).json({ error: 'No tienes permisos para realizar esta acción' });
}
// LOGIN
app.post('/api/login', async (req, res) => {
    const { username, password, codigo } = req.body;
    try {
        const gym = await pool.query('SELECT * FROM Gimnasios WHERE codigo=$1', [codigo]);
        if (gym.rows.length === 0) return res.status(401).json({ error: 'Código de gimnasio incorrecto' });
        const r = await pool.query('SELECT * FROM Usuarios WHERE username=$1 AND gimnasio_id=$2', [username, gym.rows[0].id]);
        if (r.rows.length === 0) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        const valido = await bcrypt.compare(password, r.rows[0].password);
        if (!valido) return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        req.session.usuario = r.rows[0].username;
        req.session.gimnasio_id = gym.rows[0].id;
        req.session.gimnasio_nombre = gym.rows[0].nombre;
        req.session.rol = r.rows[0].rol;
        res.json({ mensaje: 'Login exitoso', usuario: r.rows[0].username, gimnasio: gym.rows[0].nombre, rol: r.rows[0].rol });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/logout', (req, res) => {
    req.session.destroy();
    res.json({ mensaje: 'Sesión cerrada' });
});

app.get('/api/sesion', (req, res) => {
    if (req.session.usuario) res.json({ usuario: req.session.usuario, rol: req.session.rol });
    else res.status(401).json({ error: 'No autenticado' });
});

app.post('/api/cambiar-password', async (req, res) => {
    const { username, passwordActual, passwordNueva } = req.body;
    try {
        const r = await pool.query('SELECT * FROM Usuarios WHERE username=$1', [username]);
        if (r.rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
        const valido = await bcrypt.compare(passwordActual, r.rows[0].password);
        if (!valido) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
        const hash = await bcrypt.hash(passwordNueva, 10);
        await pool.query('UPDATE Usuarios SET password=$1 WHERE username=$2', [hash, username]);
        res.json({ mensaje: 'Contraseña actualizada' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// SOCIOS
app.get('/api/socios', auth, async (req, res) => {
    try {
        const r = await pool.query(`
            SELECT s.*,
                p.fecha_vencimiento,
                CASE 
                    WHEN p.fecha_vencimiento IS NULL THEN 'Sin membresía'
                    WHEN p.fecha_vencimiento >= CURRENT_DATE THEN 'Activo'
                    ELSE 'Vencido'
                END as estado_membresia
            FROM Socios s
            LEFT JOIN (
                SELECT DISTINCT ON (socio_id) socio_id, fecha_vencimiento
                FROM Pagos
                ORDER BY socio_id, id DESC
) p ON s.id = p.socio_id 
            WHERE s.gimnasio_id=$1
            ORDER BY s.fecha_registro DESC
        `, [req.session.gimnasio_id]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/socios', auth, async (req, res) => {
    const { nombre, email, telefono } = req.body;
    try {
        await pool.query('INSERT INTO Socios (nombre, email, telefono, usuario, gimnasio_id) VALUES ($1,$2,$3,$4,$5)',
            [nombre, email, telefono, req.session.usuario, req.session.gimnasio_id]);
        res.json({ mensaje: 'Socio agregado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/socios/:id', auth, async (req, res) => {
    const { nombre, email, telefono } = req.body;
    try {
        await pool.query('UPDATE Socios SET nombre=$1, email=$2, telefono=$3 WHERE id=$4 AND gimnasio_id=$5',
            [nombre, email, telefono, req.params.id, req.session.gimnasio_id]);
        res.json({ mensaje: 'Socio actualizado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/socios/:id', auth, async (req, res) => {
    try {
        await pool.query('DELETE FROM Socios WHERE id=$1 AND gimnasio_id=$2', [req.params.id, req.session.gimnasio_id]);
        res.json({ mensaje: 'Socio eliminado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});


// MEMBRESÍAS
app.get('/api/membresias', auth, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM Membresias WHERE gimnasio_id=$1 ORDER BY id', [req.session.gimnasio_id]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/membresias', auth, async (req, res) => {
    const { nombre, precio, duracion_dias } = req.body;
    try {
        await pool.query('INSERT INTO Membresias (nombre, precio, duracion_dias, gimnasio_id, activo) VALUES ($1,$2,$3,$4,true)',
            [nombre, precio, duracion_dias, req.session.gimnasio_id]);
        res.json({ mensaje: 'Membresía creada' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/membresias/:id', auth, isAdmin, async (req, res) => {
    const { nombre, precio, duracion_dias } = req.body;
    try {
        await pool.query('UPDATE Membresias SET nombre=$1, precio=$2, duracion_dias=$3 WHERE id=$4 AND gimnasio_id=$5',
            [nombre, precio, duracion_dias, req.params.id, req.session.gimnasio_id]);
        res.json({ mensaje: 'Membresía actualizada' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Activar/desactivar membresía
app.patch('/api/membresias/:id/toggle', auth, isAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT activo FROM Membresias WHERE id=$1 AND gimnasio_id=$2', [req.params.id, req.session.gimnasio_id]);
        const nuevoEstado = !r.rows[0].activo;
        await pool.query('UPDATE Membresias SET activo=$1 WHERE id=$2 AND gimnasio_id=$3', [nuevoEstado, req.params.id, req.session.gimnasio_id]);
        res.json({ mensaje: nuevoEstado ? 'Membresía activada' : 'Membresía desactivada', activo: nuevoEstado });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/membresias/:id', auth, isAdmin, async (req, res) => {
    try {
        const pagos = await pool.query('SELECT COUNT(*) as total FROM Pagos WHERE membresia_id=$1', [req.params.id]);
        if (parseInt(pagos.rows[0].total) > 0) return res.status(400).json({ error: 'No se puede eliminar porque tiene pagos asociados. Desactívala en su lugar.' });
        await pool.query('DELETE FROM Membresias WHERE id=$1 AND gimnasio_id=$2', [req.params.id, req.session.gimnasio_id]);
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
            WHERE p.gimnasio_id=$1
            ORDER BY p.fecha_pago DESC`, [req.session.gimnasio_id]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pagos', auth, async (req, res) => {
    const { socio_id, membresia_id, monto, fecha_vencimiento, metodo_pago, enviar_comprobante } = req.body;
    try {
        await pool.query('INSERT INTO Pagos (socio_id, membresia_id, monto, fecha_vencimiento, metodo_pago, gimnasio_id) VALUES ($1,$2,$3,$4,$5,$6)',
            [socio_id, membresia_id, monto, fecha_vencimiento, metodo_pago, req.session.gimnasio_id]);

        if (enviar_comprobante) {
            const socio = await pool.query('SELECT * FROM Socios WHERE id=$1', [socio_id]);
            const membresia = await pool.query('SELECT * FROM Membresias WHERE id=$1', [membresia_id]);
            const gym = await pool.query('SELECT * FROM Gimnasios WHERE id=$1', [req.session.gimnasio_id]);

            if (socio.rows[0].email) {
                await resend.emails.send({
                    from: 'GymControl <onboarding@resend.dev>',
                    to: socio.rows[0].email,
                    subject: `Comprobante de pago - ${gym.rows[0].nombre}`,
                    html: `
                        <div style="font-family:'Segoe UI',sans-serif;max-width:500px;margin:0 auto;background:#f9f9f9;border-radius:12px;overflow:hidden;">
                            <div style="background:#1a1a2e;padding:24px;text-align:center;">
                                <h1 style="color:#e94560;margin:0;font-size:24px;">💪 ${gym.rows[0].nombre}</h1>
                                <p style="color:#aaa;margin:8px 0 0;font-size:13px;">Comprobante de pago</p>
                            </div>
                            <div style="padding:32px;">
                                <p style="font-size:16px;color:#333;">Hola <strong>${socio.rows[0].nombre}</strong>,</p>
                                <p style="color:#666;margin:8px 0 24px;">Tu pago ha sido registrado exitosamente.</p>
                                <div style="background:white;border-radius:8px;padding:20px;border:1px solid #eee;">
                                    <table style="width:100%;border-collapse:collapse;">
                                        <tr><td style="padding:8px 0;color:#888;font-size:13px;">Membresía</td><td style="padding:8px 0;font-weight:600;text-align:right;">${membresia.rows[0].nombre}</td></tr>
                                        <tr><td style="padding:8px 0;color:#888;font-size:13px;">Monto</td><td style="padding:8px 0;font-weight:600;color:#27ae60;text-align:right;">S/. ${parseFloat(monto).toFixed(2)}</td></tr>
                                        <tr><td style="padding:8px 0;color:#888;font-size:13px;">Método</td><td style="padding:8px 0;font-weight:600;text-align:right;">${metodo_pago}</td></tr>
                                        <tr><td style="padding:8px 0;color:#888;font-size:13px;">Fecha de pago</td><td style="padding:8px 0;font-weight:600;text-align:right;">${new Date().toLocaleDateString('es-ES')}</td></tr>
                                        <tr style="border-top:1px solid #eee;"><td style="padding:12px 0 0;color:#888;font-size:13px;">Vence</td><td style="padding:12px 0 0;font-weight:700;color:#e94560;text-align:right;">${new Date(fecha_vencimiento + 'T00:00:00').toLocaleDateString('es-ES')}</td></tr>
                                    </table>
                                </div>
                                <p style="color:#aaa;font-size:12px;text-align:center;margin-top:24px;">Gracias por tu preferencia 💪</p>
                            </div>
                        </div>
                    `
                });
            }
        }
        res.json({ mensaje: 'Pago registrado correctamente' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// CAJA
// CAJA
app.get('/api/caja/resumen', auth, async (req, res) => {
    try {
        const gym = await pool.query('SELECT ultimo_cierre FROM Gimnasios WHERE id=$1', [req.session.gimnasio_id]);
        const ultimoCierre = gym.rows[0].ultimo_cierre;
        
        let filtro = 'p.fecha_pago=CURRENT_DATE';
        let params = [req.session.gimnasio_id];
        
        if (ultimoCierre) {
            filtro = 'p.created_at > $2';
            params = [req.session.gimnasio_id, ultimoCierre];
        }

        const efectivo = await pool.query(`SELECT COALESCE(SUM(monto),0) as total FROM Pagos p JOIN Socios s ON p.socio_id=s.id WHERE p.gimnasio_id=$1 AND p.metodo_pago='Efectivo' AND p.fecha_pago=CURRENT_DATE ${ultimoCierre ? 'AND p.created_at > $2' : ''}`, params);
        const transferencia = await pool.query(`SELECT COALESCE(SUM(monto),0) as total FROM Pagos p JOIN Socios s ON p.socio_id=s.id WHERE p.gimnasio_id=$1 AND p.metodo_pago='Transferencia' AND p.fecha_pago=CURRENT_DATE ${ultimoCierre ? 'AND p.created_at > $2' : ''}`, params);
        const pagosHoy = await pool.query(`
            SELECT p.id, s.nombre as socio, m.nombre as membresia, p.monto, p.metodo_pago, p.fecha_pago, p.fecha_vencimiento
            FROM Pagos p JOIN Socios s ON p.socio_id=s.id JOIN Membresias m ON p.membresia_id=m.id
            WHERE p.gimnasio_id=$1 AND p.fecha_pago=CURRENT_DATE ${ultimoCierre ? 'AND p.created_at > $2' : ''}
            ORDER BY p.id DESC`, params);
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
        const gym = await pool.query('SELECT ultimo_cierre FROM Gimnasios WHERE id=$1', [req.session.gimnasio_id]);
        const ultimoCierre = gym.rows[0].ultimo_cierre;
        const params = [req.session.gimnasio_id];
        if (ultimoCierre) params.push(ultimoCierre);

        const efectivo = await pool.query(`SELECT COALESCE(SUM(monto),0) as total FROM Pagos WHERE gimnasio_id=$1 AND metodo_pago='Efectivo' AND fecha_pago=CURRENT_DATE ${ultimoCierre ? 'AND created_at > $2' : ''}`, params);
        const transferencia = await pool.query(`SELECT COALESCE(SUM(monto),0) as total FROM Pagos WHERE gimnasio_id=$1 AND metodo_pago='Transferencia' AND fecha_pago=CURRENT_DATE ${ultimoCierre ? 'AND created_at > $2' : ''}`, params);
        const te = parseFloat(efectivo.rows[0].total);
        const tt = parseFloat(transferencia.rows[0].total);
        
        await pool.query('INSERT INTO CierreCaja (usuario, total_efectivo, total_transferencia, total_general, observaciones, gimnasio_id) VALUES ($1,$2,$3,$4,$5,$6)',
            [req.session.usuario, te, tt, te+tt, observaciones, req.session.gimnasio_id]);
        
        // Actualizar último cierre
        await pool.query('UPDATE Gimnasios SET ultimo_cierre=NOW() WHERE id=$1', [req.session.gimnasio_id]);
        
        res.json({ mensaje: 'Cierre realizado', totalEfectivo: te, totalTransferencia: tt, totalGeneral: te+tt });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/caja/historial', auth, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM CierreCaja WHERE gimnasio_id=$1 ORDER BY fecha_cierre DESC', [req.session.gimnasio_id]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// REPORTES
app.get('/api/reportes', auth, async (req, res) => {
    try {
        const gid = req.session.gimnasio_id;
        const totalSocios = await pool.query('SELECT COUNT(*) as total FROM Socios WHERE gimnasio_id=$1', [gid]);
        const totalIngresos = await pool.query('SELECT COALESCE(SUM(monto),0) as total FROM Pagos WHERE gimnasio_id=$1', [gid]);
        const pagosMes = await pool.query(`SELECT COALESCE(SUM(monto),0) as total FROM Pagos WHERE gimnasio_id=$1 AND EXTRACT(MONTH FROM fecha_pago)=EXTRACT(MONTH FROM CURRENT_DATE) AND EXTRACT(YEAR FROM fecha_pago)=EXTRACT(YEAR FROM CURRENT_DATE)`, [gid]);
        const membresiasPopulares = await pool.query(`SELECT m.nombre, COUNT(*) as cantidad FROM Pagos p JOIN Membresias m ON p.membresia_id=m.id WHERE p.gimnasio_id=$1 GROUP BY m.nombre ORDER BY cantidad DESC`, [gid]);
        const sociosRecientes = await pool.query('SELECT nombre, email, fecha_registro FROM Socios WHERE gimnasio_id=$1 ORDER BY fecha_registro DESC LIMIT 5', [gid]);
        res.json({
            totalSocios: totalSocios.rows[0].total,
            totalIngresos: totalIngresos.rows[0].total,
            pagosMes: pagosMes.rows[0].total,
            membresiasPopulares: membresiasPopulares.rows,
            sociosRecientes: sociosRecientes.rows
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// CAMBIAR CONTRASEÑA
app.post('/api/cambiar-password', async (req, res) => {
    const { username, passwordActual, passwordNueva, codigo } = req.body;
    try {
        const gym = await pool.query('SELECT * FROM Gimnasios WHERE codigo=$1', [codigo]);
        if (gym.rows.length === 0) return res.status(401).json({ error: 'Código de gimnasio incorrecto' });
        const r = await pool.query('SELECT * FROM Usuarios WHERE username=$1 AND gimnasio_id=$2', [username, gym.rows[0].id]);
        if (r.rows.length === 0) return res.status(401).json({ error: 'Usuario no encontrado' });
        const valido = await bcrypt.compare(passwordActual, r.rows[0].password);
        if (!valido) return res.status(401).json({ error: 'Contraseña actual incorrecta' });
        const hash = await bcrypt.hash(passwordNueva, 10);
        await pool.query('UPDATE Usuarios SET password=$1 WHERE username=$2 AND gimnasio_id=$3', [hash, username, gym.rows[0].id]);
        res.json({ mensaje: 'Contraseña actualizada' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// EXPORTAR
app.get('/api/exportar/socios/excel', auth, async (req, res) => {
    try {
        const r = await pool.query('SELECT * FROM Socios WHERE gimnasio_id=$1 ORDER BY fecha_registro DESC', [req.session.gimnasio_id]);
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
        const r = await pool.query('SELECT * FROM Socios WHERE gimnasio_id=$1 ORDER BY fecha_registro DESC', [req.session.gimnasio_id]);
        const doc = new PDFDocument({ margin: 40 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=socios.pdf');
        doc.pipe(res);
        doc.fontSize(20).fillColor('#e94560').text('GymControl - Lista de Socios', { align: 'center' });
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
        const r = await pool.query(`SELECT s.nombre as socio, m.nombre as membresia, p.monto, p.metodo_pago, p.fecha_pago, p.fecha_vencimiento FROM Pagos p JOIN Socios s ON p.socio_id=s.id JOIN Membresias m ON p.membresia_id=m.id WHERE p.gimnasio_id=$1 ORDER BY p.fecha_pago DESC`, [req.session.gimnasio_id]);
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
// Registrar nuevo usuario
app.post('/api/usuarios', auth, isAdmin, async (req, res) => {
    const { username, password } = req.body;
    try {
        const existe = await pool.query('SELECT * FROM Usuarios WHERE username=$1', [username]);
        if (existe.rows.length > 0) return res.status(400).json({ error: 'El usuario ya existe' });
        const hash = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO Usuarios (username, password) VALUES ($1,$2)', [username, hash]);
        res.json({ mensaje: 'Usuario creado correctamente' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Listar usuarios
app.get('/api/usuarios', auth, isAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT id, username FROM Usuarios ORDER BY id');
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Eliminar usuario
app.delete('/api/usuarios/:id', auth, isAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT username FROM Usuarios WHERE id=$1', [req.params.id]);
        if (r.rows[0]?.username === 'admin') return res.status(400).json({ error: 'No puedes eliminar al admin' });
        await pool.query('DELETE FROM Usuarios WHERE id=$1', [req.params.id]);
        res.json({ mensaje: 'Usuario eliminado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Registro de gimnasio
app.post('/api/registro-gimnasio', async (req, res) => {
    const { nombre, email, password } = req.body;
    try {
        const existe = await pool.query('SELECT * FROM Gimnasios WHERE email=$1', [email]);
        if (existe.rows.length > 0) return res.status(400).json({ error: 'Este email ya está registrado' });
        const codigo = crypto.randomBytes(4).toString('hex').toUpperCase();
        const gimnasio = await pool.query(
            'INSERT INTO Gimnasios (nombre, email, codigo) VALUES ($1,$2,$3) RETURNING *',
            [nombre, email, codigo]
        );
        const hash = await bcrypt.hash(password, 10);
        await pool.query(
            'INSERT INTO Usuarios (username, password, gimnasio_id) VALUES ($1,$2,$3)',
            ['admin', hash, gimnasio.rows[0].id]
        );
        // Membresías por defecto
        await pool.query(`
            INSERT INTO Membresias (nombre, precio, duracion_dias, gimnasio_id) VALUES
            ('Diaria', 5.00, 1, $1),
            ('Mensual', 120.00, 30, $1),
            ('Anual', 1200.00, 365, $1)
        `, [gimnasio.rows[0].id]);
        res.json({ mensaje: 'Gimnasio registrado', codigo });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/caja/cierre-pdf/:id', auth, async (req, res) => {
    try {
        const cierre = await pool.query('SELECT * FROM CierreCaja WHERE id=$1 AND gimnasio_id=$2', [req.params.id, req.session.gimnasio_id]);
        const gym = await pool.query('SELECT * FROM Gimnasios WHERE id=$1', [req.session.gimnasio_id]);
        
        if (cierre.rows.length === 0) return res.status(404).json({ error: 'Cierre no encontrado' });
        
        const c = cierre.rows[0];
        const g = gym.rows[0];
        const doc = new PDFDocument({ margin: 40, size: 'A5' });
        
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', `attachment; filename=cierre-caja-${req.params.id}.pdf`);
        doc.pipe(res);

        // Header
        doc.fontSize(18).fillColor('#e94560').text(g.nombre, { align: 'center' });
        doc.fontSize(11).fillColor('#888').text('Reporte de Cierre de Caja', { align: 'center' });
        doc.moveDown(0.5);
        doc.fontSize(10).fillColor('#333').text(`Fecha: ${new Date(c.fecha_cierre).toLocaleDateString('es-ES', {day:'2-digit', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit'})}`, { align: 'center' });
        doc.fontSize(10).text(`Cajero: ${c.usuario}`, { align: 'center' });
        doc.moveDown();

        // Línea separadora
        doc.moveTo(40, doc.y).lineTo(400, doc.y).strokeColor('#eee').stroke();
        doc.moveDown();

        // Detalle
        doc.fontSize(12).fillColor('#333');
        doc.text('Efectivo:', 40, doc.y);
        doc.text(`S/. ${parseFloat(c.total_efectivo).toFixed(2)}`, { align: 'right' });
        doc.moveDown(0.5);
        doc.text('Transferencia:', 40, doc.y);
        doc.text(`S/. ${parseFloat(c.total_transferencia).toFixed(2)}`, { align: 'right' });
        doc.moveDown();

        // Línea separadora
        doc.moveTo(40, doc.y).lineTo(400, doc.y).strokeColor('#eee').stroke();
        doc.moveDown();

        // Total
        doc.fontSize(16).fillColor('#e94560').text('TOTAL:', 40, doc.y);
        doc.text(`S/. ${parseFloat(c.total_general).toFixed(2)}`, { align: 'right' });
        doc.moveDown();

        // Observaciones
        if (c.observaciones) {
            doc.fontSize(10).fillColor('#888').text(`Observaciones: ${c.observaciones}`, { align: 'center' });
        }

        doc.moveDown();
        doc.fontSize(9).fillColor('#aaa').text('GymControl - Sistema de Gestión', { align: 'center' });
        doc.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static('public'));

const server = app.listen(process.env.PORT || 3000, () => console.log('Servidor corriendo en puerto ' + (process.env.PORT || 3000)));
server.on('error', e => console.log('Error:', e.message));
process.stdin.resume();