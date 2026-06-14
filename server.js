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
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

// Crear tablas si no existen (Corregido con los campos faltantes)
async function initDB() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS Gimnasios (
                id SERIAL PRIMARY KEY,
                nombre VARCHAR(100) NOT NULL,
                email VARCHAR(100) UNIQUE NOT NULL,
                codigo VARCHAR(20) UNIQUE NOT NULL,
                ultimo_cierre TIMESTAMP,
                fecha_registro TIMESTAMP DEFAULT NOW()
            );
            CREATE TABLE IF NOT EXISTS Usuarios (
    id SERIAL PRIMARY KEY,
    username VARCHAR(50) NOT NULL,
    password VARCHAR(255) NOT NULL,
    rol VARCHAR(20) DEFAULT 'user',
    gimnasio_id INT REFERENCES Gimnasios(id),
    reset_token VARCHAR(6),
    reset_token_expires TIMESTAMP,
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
                activo BOOLEAN DEFAULT true,
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
                gimnasio_id INT REFERENCES Gimnasios(id),
                created_at TIMESTAMP DEFAULT NOW()
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
    } catch (err) {
        console.error('Error inicializando la base de datos ❌:', err.message);
    }
}

// Middlewares de protección
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
        if (gym.rows[0].estado === 'pendiente') return res.status(403).json({ error: 'Tu cuenta está pendiente de aprobación. Contáctanos por WhatsApp para activarla.' });
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
        await pool.query('INSERT INTO Pagos (socio_id, membresia_id, monto, fecha_vencimiento, metodo_pago, gimnasio_id, cajero) VALUES ($1,$2,$3,$4,$5,$6,$7)',
    [socio_id, membresia_id, monto, fecha_vencimiento, metodo_pago, req.session.gimnasio_id, req.session.usuario]);
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
        const usuario = req.session.usuario;
        const rol = req.session.rol;
        const gid = req.session.gimnasio_id;

        // Obtener último cierre del cajero actual
        const ultimoCierreQ = await pool.query('SELECT ultimo_cierre FROM CierresCajero WHERE usuario=$1 AND gimnasio_id=$2 ORDER BY ultimo_cierre DESC LIMIT 1', [usuario, gid]);
        const ultimoCierre = ultimoCierreQ.rows.length > 0 ? ultimoCierreQ.rows[0].ultimo_cierre : null;

        // Admin ve todos, usuario solo los suyos
        const filtroUsuario = `AND p.cajero=$2`;
        const params = [gid, usuario];
        const extraParam = ultimoCierre ? [...params, ultimoCierre] : params;
        const extraFiltro = ultimoCierre ? `AND p.created_at > $${params.length + 1}` : '';

        const efectivo = await pool.query(`SELECT COALESCE(SUM(monto),0) as total FROM Pagos p WHERE p.gimnasio_id=$1 ${filtroUsuario} AND p.metodo_pago='Efectivo' AND p.fecha_pago=CURRENT_DATE ${extraFiltro}`, extraParam);
        const transferencia = await pool.query(`SELECT COALESCE(SUM(monto),0) as total FROM Pagos p WHERE p.gimnasio_id=$1 ${filtroUsuario} AND p.metodo_pago='Transferencia' AND p.fecha_pago=CURRENT_DATE ${extraFiltro}`, extraParam);
        const pagosHoy = await pool.query(`
            SELECT p.id, s.nombre as socio, m.nombre as membresia, p.monto, p.metodo_pago, p.fecha_pago, p.fecha_vencimiento, p.cajero
            FROM Pagos p JOIN Socios s ON p.socio_id=s.id JOIN Membresias m ON p.membresia_id=m.id
            WHERE p.gimnasio_id=$1 ${filtroUsuario} AND p.fecha_pago=CURRENT_DATE ${extraFiltro}
            ORDER BY p.id DESC`, extraParam);
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
        const usuario = req.session.usuario;
        const rol = req.session.rol;
        const gid = req.session.gimnasio_id;

        const ultimoCierreQ = await pool.query('SELECT ultimo_cierre FROM CierresCajero WHERE usuario=$1 AND gimnasio_id=$2 ORDER BY ultimo_cierre DESC LIMIT 1', [usuario, gid]);
        const ultimoCierre = ultimoCierreQ.rows.length > 0 ? ultimoCierreQ.rows[0].ultimo_cierre : null;

        const filtroUsuario = `AND cajero=$2`;
        const params = [gid, usuario];
        const extraParam = ultimoCierre ? [...params, ultimoCierre] : params;
        const extraFiltro = ultimoCierre ? `AND created_at > $${params.length + 1}` : '';

        const efectivo = await pool.query(`SELECT COALESCE(SUM(monto),0) as total FROM Pagos WHERE gimnasio_id=$1 ${filtroUsuario} AND metodo_pago='Efectivo' AND fecha_pago=CURRENT_DATE ${extraFiltro}`, extraParam);
        const transferencia = await pool.query(`SELECT COALESCE(SUM(monto),0) as total FROM Pagos WHERE gimnasio_id=$1 ${filtroUsuario} AND metodo_pago='Transferencia' AND fecha_pago=CURRENT_DATE ${extraFiltro}`, extraParam);
        const te = parseFloat(efectivo.rows[0].total);
        const tt = parseFloat(transferencia.rows[0].total);

        await pool.query('INSERT INTO CierreCaja (usuario, total_efectivo, total_transferencia, total_general, observaciones, gimnasio_id) VALUES ($1,$2,$3,$4,$5,$6)',
            [usuario, te, tt, te+tt, observaciones, gid]);

        // Registrar cierre del cajero
        await pool.query('INSERT INTO CierresCajero (usuario, gimnasio_id) VALUES ($1,$2)', [usuario, gid]);

        res.json({ mensaje: 'Cierre realizado', totalEfectivo: te, totalTransferencia: tt, totalGeneral: te+tt });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/caja/historial', auth, async (req, res) => {
    try {
        const usuario = req.session.usuario;
        const rol = req.session.rol;
        const gid = req.session.gimnasio_id;
        let r;
        if (rol === 'admin') {
            r = await pool.query('SELECT * FROM CierreCaja WHERE gimnasio_id=$1 ORDER BY fecha_cierre DESC', [gid]);
        } else {
            r = await pool.query('SELECT * FROM CierreCaja WHERE gimnasio_id=$1 AND usuario=$2 ORDER BY fecha_cierre DESC', [gid, usuario]);
        }
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

// USUARIOS (Limpiado y Unificado con Scope de Gimnasio Seguro)
app.get('/api/usuarios', auth, isAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT id, username, rol FROM Usuarios WHERE gimnasio_id=$1 ORDER BY id', [req.session.gimnasio_id]);
        res.json(r.rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/usuarios', auth, isAdmin, async (req, res) => {
    const { username, password, rol } = req.body;
    try {
        const existe = await pool.query('SELECT * FROM Usuarios WHERE username=$1 AND gimnasio_id=$2', [username, req.session.gimnasio_id]);
        if (existe.rows.length > 0) return res.status(400).json({ error: 'El usuario ya existe en tu gimnasio' });
        
        const hash = await bcrypt.hash(password, 10);
        await pool.query('INSERT INTO Usuarios (username, password, gimnasio_id, rol) VALUES ($1,$2,$3,$4)', 
            [username, hash, req.session.gimnasio_id, rol || 'user']);
        res.json({ mensaje: 'Usuario creado correctamente' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/usuarios/:id', auth, isAdmin, async (req, res) => {
    try {
        const r = await pool.query('SELECT username FROM Usuarios WHERE id=$1 AND gimnasio_id=$2', [req.params.id, req.session.gimnasio_id]);
        if (r.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado' });
        if (r.rows[0].username === 'admin') return res.status(400).json({ error: 'No puedes eliminar al administrador principal' });
        
        await pool.query('DELETE FROM Usuarios WHERE id=$1 AND gimnasio_id=$2', [req.params.id, req.session.gimnasio_id]);
        res.json({ mensaje: 'Usuario eliminado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// CAMBIAR CONTRASEÑA
// STEP 1: Solicitar código de recuperación por correo
app.post('/api/olvido-password/solicitar', async (req, res) => {
    const { username, codigo } = req.body;
    try {
        // Verificar que el gimnasio exista
        const gym = await pool.query('SELECT * FROM Gimnasios WHERE codigo=$1', [codigo]);
        if (gym.rows.length === 0) return res.status(404).json({ error: 'Código de gimnasio incorrecto' });

        // Verificar que el usuario pertenezca a ese gimnasio
        const user = await pool.query('SELECT * FROM Usuarios WHERE username=$1 AND gimnasio_id=$2', [username, gym.rows[0].id]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado en este gimnasio' });

        // Generar un token numérico de 6 dígitos y definir expiración (15 minutos)
        const token = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 15 * 60 * 1000); 

        // Guardar el token en la base de datos
        await pool.query('UPDATE Usuarios SET reset_token=$1, reset_token_expires=$2 WHERE id=$3', [token, expires, user.rows[0].id]);

        // Enviar el código al correo del gimnasio usando Resend
        if (gym.rows[0].email) {
            await resend.emails.send({
                from: 'GymControl <onboarding@resend.dev>',
                to: gym.rows[0].email,
                subject: `Código de recuperación - ${gym.rows[0].nombre}`,
                html: `
                    <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
                        <h2>Recuperación de contraseña</h2>
                        <p>Se ha solicitado un cambio de contraseña para el usuario: <strong>${username}</strong></p>
                        <p>Tu código de verificación de seguridad es:</p>
                        <div style="background: #f4f4f6; text-align: center; padding: 10px; font-size: 24px; font-weight: bold; color: #e94560; letter-spacing: 4px;">
                            ${token}
                        </div>
                        <p style="font-size: 12px; color: #888; margin-top: 15px;">Este código expirará en 15 minutos.</p>
                    </div>
                `
            });
        }

        res.json({ mensaje: 'Código enviado al correo del gimnasio' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// STEP 1: Solicitar código de recuperación por correo
app.post('/api/olvido-password/solicitar', async (req, res) => {
    const { username, codigo } = req.body;
    try {
        // Verificar que el gimnasio exista
        const gym = await pool.query('SELECT * FROM Gimnasios WHERE codigo=$1', [codigo]);
        if (gym.rows.length === 0) return res.status(404).json({ error: 'Código de gimnasio incorrecto' });

        // Verificar que el usuario pertenezca a ese gimnasio
        const user = await pool.query('SELECT * FROM Usuarios WHERE username=$1 AND gimnasio_id=$2', [username, gym.rows[0].id]);
        if (user.rows.length === 0) return res.status(404).json({ error: 'Usuario no encontrado en este gimnasio' });

        // Generar un token numérico de 6 dígitos y definir expiración (15 minutos)
        const token = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 15 * 60 * 1000); 

        // Guardar el token en la base de datos
        await pool.query('UPDATE Usuarios SET reset_token=$1, reset_token_expires=$2 WHERE id=$3', [token, expires, user.rows[0].id]);

        // Enviar el código al correo del gimnasio usando Resend
        if (gym.rows[0].email) {
            await resend.emails.send({
                from: 'GymControl <onboarding@resend.dev>', // Si tienes un dominio configurado, cámbialo aquí
                to: gym.rows[0].email,
                subject: `Código de recuperación - ${gym.rows[0].nombre}`,
                html: `
                    <div style="font-family: sans-serif; max-width: 400px; margin: 0 auto; padding: 20px; border: 1px solid #eee; border-radius: 8px;">
                        <h2>Recuperación de contraseña</h2>
                        <p>Se ha solicitado un cambio de contraseña para el usuario: <strong>${username}</strong></p>
                        <p>Tu código de verificación de seguridad es:</p>
                        <div style="background: #f4f4f6; text-align: center; padding: 10px; font-size: 24px; font-weight: bold; color: #e94560; letter-spacing: 4px;">
                            ${token}
                        </div>
                        <p style="font-size: 12px; color: #888; margin-top: 15px;">Este código expirará en 15 minutos.</p>
                    </div>
                `
            });
        }

        res.json({ mensaje: 'Código enviado al correo del gimnasio' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// STEP 2: Verificar código y cambiar la contraseña sin saber la anterior
app.post('/api/olvido-password/confirmar', async (req, res) => {
    const { username, codigo, token, passwordNueva } = req.body;
    try {
        const gym = await pool.query('SELECT id FROM Gimnasios WHERE codigo=$1', [codigo]);
        if (gym.rows.length === 0) return res.status(404).json({ error: 'Código de gimnasio incorrecto' });

        // Buscar al usuario que coincida con el nombre, gimnasio, el token enviado y que no haya expirado
        const r = await pool.query(
            'SELECT * FROM Usuarios WHERE username=$1 AND gimnasio_id=$2 AND reset_token=$3 AND reset_token_expires > NOW()',
            [username, gym.rows[0].id, token]
        );
        
        if (r.rows.length === 0) {
            return res.status(400).json({ error: 'El código es incorrecto o ya ha expirado' });
        }

        // Encriptar la nueva contraseña
        const hash = await bcrypt.hash(passwordNueva, 10);
        
        // Actualizar contraseña y limpiar los campos del token de recuperación
        await pool.query(
            'UPDATE Usuarios SET password=$1, reset_token=NULL, reset_token_expires=NULL WHERE id=$2', 
            [hash, r.rows[0].id]
        );

        res.json({ mensaje: 'Contraseña actualizada correctamente' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// EXPORTAR ARCHIVOS
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

// REGISTRO DE NUEVO GIMNASIO
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
            'INSERT INTO Usuarios (username, password, gimnasio_id, rol) VALUES ($1,$2,$3,$4)',
            ['admin', hash, gimnasio.rows[0].id, 'admin']
        );
        
        // Membresías por defecto
        await pool.query(`
            INSERT INTO Membresias (nombre, precio, duracion_dias, gimnasio_id) VALUES
            ('Diaria', 5.00, 1, $1),
            ('Mensual', 120.00, 30, $1),
            ('Anual', 1200.00, 365, $1)
        `, [gimnasio.rows[0].id]);
        
        res.json({ mensaje: 'Gimnasio registrado con éxito', codigo });
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

        doc.fontSize(18).fillColor('#e94560').text(g.nombre, { align: 'center' });
        doc.fontSize(11).fillColor('#888').text('Reporte de Cierre de Caja', { align: 'center' });
        doc.moveDown(0.5);
        const fechaCierre = new Date(c.fecha_cierre);
        fechaCierre.setHours(fechaCierre.getHours() - 5);
        doc.fontSize(10).fillColor('#333').text(`Fecha: ${fechaCierre.toLocaleString('es-ES', {day:'2-digit', month:'long', year:'numeric', hour:'2-digit', minute:'2-digit'})}`, { align: 'center' });
        doc.fontSize(10).text(`Cajero: ${c.usuario}`, { align: 'center' });
        doc.moveDown();

        doc.moveTo(40, doc.y).lineTo(400, doc.y).strokeColor('#eee').stroke();
        doc.moveDown();

        doc.fontSize(12).fillColor('#333');
        doc.text('Efectivo:', 40, doc.y);
        doc.text(`S/. ${parseFloat(c.total_efectivo).toFixed(2)}`, { align: 'right' });
        doc.moveDown(0.5);
        doc.text('Transferencia:', 40, doc.y);
        doc.text(`S/. ${parseFloat(c.total_transferencia).toFixed(2)}`, { align: 'right' });
        doc.moveDown();

        doc.moveTo(40, doc.y).lineTo(400, doc.y).strokeColor('#eee').stroke();
        doc.moveDown();

        doc.fontSize(16).fillColor('#e94560').text('TOTAL:', 40, doc.y);
        doc.text(`S/. ${parseFloat(c.total_general).toFixed(2)}`, { align: 'right' });
        doc.moveDown();

        if (c.observaciones) {
            doc.fontSize(10).fillColor('#888').text(`Observaciones: ${c.observaciones}`, { align: 'center' });
        }

        doc.moveDown();
        doc.fontSize(9).fillColor('#aaa').text('GymControl - Sistema de Gestión', { align: 'center' });
        doc.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Aprobar gimnasio (solo tú sabes esta URL)
app.post('/api/admin-secret/aprobar-gimnasio', async (req, res) => {
    const { codigo, secret } = req.body;
    if (secret !== 'gymcontrol2026secret') return res.status(403).json({ error: 'No autorizado' });
    try {
        await pool.query("UPDATE Gimnasios SET estado='activo' WHERE codigo=$1", [codigo]);
        res.json({ mensaje: 'Gimnasio aprobado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.use(express.static('public'));

// INICIALIZACIÓN DEL SERVIDOR (Llamando correctamente a initDB)
const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, async () => {
    await initDB();
    console.log(`Servidor corriendo en puerto ${PORT} 🚀`);
});

server.on('error', e => console.error('Error en el servidor:', e.message));
process.stdin.resume();