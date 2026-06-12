const express = require('express');
const sql = require('mssql');
const session = require('express-session');
const app = express();

app.use(require('cors')({
    origin: true,
    credentials: true // Permite el intercambio de cookies/sesiones
}));
app.use(express.json());

// Configuración de sesión optimizada para desarrollo local
app.use(session({
    secret: 'gimnasio123',
    resave: true,             // Forzar a que la sesión se guarde en el almacén
    saveUninitialized: true,  // Forzar a que una sesión nueva se inicialice
    cookie: { 
        secure: false,        // Debe ser false ya que estás usando HTTP (localhost) y no HTTPS
        maxAge: 1000 * 60 * 60 * 24 // Duración de 1 día
    }
}));

const db = {
    server: 'localhost',
    database: 'GimnasioDB',
    user: 'sa',
    password: 'Gimnasio123!',
    options: { trustServerCertificate: true }
};

// Middleware proteger rutas
function auth(req, res, next) {
    if (req.session && req.session.usuario) return next();
    res.status(401).json({ error: 'No autorizado' });
}

// Login con guardado explícito de sesión antes de responder
app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    try {
        await sql.connect(db);
        const r = await sql.query`SELECT * FROM Usuarios WHERE username=${username} AND password=${password}`;
        
        if (r.recordset.length === 0) {
            return res.status(401).json({ error: 'Usuario o contraseña incorrectos' });
        }
        
        // Guardamos los datos en la sesión
        req.session.usuario = r.recordset[0].username;
        
        // FORZAMOS el guardado manual en el servidor antes de mandar la respuesta exitosa
        req.session.save((err) => {
            if (err) {
                return res.status(500).json({ error: 'Error al guardar la sesión' });
            }
            res.json({ mensaje: 'Login exitoso', usuario: req.session.usuario });
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// Logout
app.post('/api/logout', (req, res) => {
    req.session.destroy((err) => {
        if (err) return res.status(500).json({ error: 'No se pudo cerrar la sesión' });
        res.clearCookie('connect.sid'); // Limpia la cookie del navegador
        res.json({ mensaje: 'Sesión cerrada' });
    });
});

// Verificar sesión
app.get('/api/sesion', (req, res) => {
    if (req.session && req.session.usuario) {
        res.json({ usuario: req.session.usuario });
    } else {
        res.status(401).json({ error: 'No autenticado' });
    }
});

// Socios (protegidas)
app.get('/api/socios', auth, async (req, res) => {
    try {
        await sql.connect(db);
        const r = await sql.query`SELECT * FROM Socios WHERE usuario=${req.session.usuario} ORDER BY fecha_registro DESC`;
        res.json(r.recordset);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/socios', auth, async (req, res) => {
    const { nombre, email, telefono } = req.body;
    try {
        await sql.connect(db);
        await sql.query`INSERT INTO Socios (nombre, email, telefono, usuario) VALUES (${nombre}, ${email}, ${telefono}, ${req.session.usuario})`;
        res.json({ mensaje: 'Socio agregado correctamente' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/socios/:id', auth, async (req, res) => {
    const { id } = req.params;
    const { nombre, email, telefono } = req.body;
    try {
        await sql.connect(db);
        await sql.query`UPDATE Socios SET nombre=${nombre}, email=${email}, telefono=${telefono} WHERE id=${id} AND usuario=${req.session.usuario}`;
        res.json({ mensaje: 'Socio actualizado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/socios/:id', auth, async (req, res) => {
    const { id } = req.params;
    try {
        await sql.connect(db);
        await sql.query`DELETE FROM Socios WHERE id=${id} AND usuario=${req.session.usuario}`;
        res.json({ mensaje: 'Socio eliminado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Cambiar contraseña
app.post('/api/cambiar-password', async (req, res) => {
    const { username, passwordActual, passwordNueva } = req.body;
    try {
        await sql.connect(db);
        const r = await sql.query`SELECT * FROM Usuarios WHERE username=${username} AND password=${passwordActual}`;
        if (r.recordset.length === 0) return res.status(401).json({ error: 'Usuario o contraseña actual incorrectos' });
        await sql.query`UPDATE Usuarios SET password=${passwordNueva} WHERE username=${username}`;
        res.json({ mensaje: 'Contraseña actualizada correctamente' });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// === MEMBRESÍAS ===
app.get('/api/membresias', auth, async (req, res) => {
    try {
        await sql.connect(db);
        const r = await sql.query('SELECT * FROM Membresias');
        res.json(r.recordset);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/membresias', auth, async (req, res) => {
    const { nombre, precio, duracion_dias } = req.body;
    try {
        await sql.connect(db);
        await sql.query`INSERT INTO Membresias (nombre, precio, duracion_dias) VALUES (${nombre}, ${precio}, ${duracion_dias})`;
        res.json({ mensaje: 'Membresía creada' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/api/membresias/:id', auth, async (req, res) => {
    const { id } = req.params;
    const { nombre, precio, duracion_dias } = req.body;
    try {
        await sql.connect(db);
        await sql.query`UPDATE Membresias SET nombre=${nombre}, precio=${precio}, duracion_dias=${duracion_dias} WHERE id=${id}`;
        res.json({ mensaje: 'Membresía actualizada' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/membresias/:id', auth, async (req, res) => {
    const { id } = req.params;
    try {
        await sql.connect(db);
        await sql.query`DELETE FROM Membresias WHERE id=${id}`;
        res.json({ mensaje: 'Membresía eliminada' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// === PAGOS ===
app.get('/api/pagos', auth, async (req, res) => {
    try {
        await sql.connect(db);
        const r = await sql.query`
            SELECT p.id, s.nombre as socio, m.nombre as membresia, 
                   p.fecha_pago, p.fecha_vencimiento, p.monto
            FROM Pagos p
            JOIN Socios s ON p.socio_id = s.id
            JOIN Membresias m ON p.membresia_id = m.id
            WHERE s.usuario = ${req.session.usuario}
            ORDER BY p.fecha_pago DESC
        `;
        res.json(r.recordset);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/pagos', auth, async (req, res) => {
    const { socio_id, membresia_id, monto, fecha_vencimiento, metodo_pago } = req.body;
    try {
        await sql.connect(db);
        await sql.query`INSERT INTO Pagos (socio_id, membresia_id, monto, fecha_vencimiento, metodo_pago) VALUES (${socio_id}, ${membresia_id}, ${monto}, ${fecha_vencimiento}, ${metodo_pago})`;
        res.json({ mensaje: 'Pago registrado' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// === REPORTES ===
app.get('/api/reportes', auth, async (req, res) => {
    try {
        await sql.connect(db);
        const u = req.session.usuario;
        const totalSocios = await sql.query`SELECT COUNT(*) as total FROM Socios WHERE usuario=${u}`;
        const totalIngresos = await sql.query`SELECT ISNULL(SUM(p.monto),0) as total FROM Pagos p JOIN Socios s ON p.socio_id=s.id WHERE s.usuario=${u}`;
        const pagosMes = await sql.query`SELECT ISNULL(SUM(p.monto),0) as total FROM Pagos p JOIN Socios s ON p.socio_id=s.id WHERE s.usuario=${u} AND MONTH(p.fecha_pago)=MONTH(GETDATE()) AND YEAR(p.fecha_pago)=YEAR(GETDATE())`;
        const membresiasPopulares = await sql.query`SELECT m.nombre, COUNT(*) as cantidad FROM Pagos p JOIN Membresias m ON p.membresia_id=m.id JOIN Socios s ON p.socio_id=s.id WHERE s.usuario=${u} GROUP BY m.nombre ORDER BY cantidad DESC`;
        const sociosRecientes = await sql.query`SELECT TOP 5 nombre, email, fecha_registro FROM Socios WHERE usuario=${u} ORDER BY fecha_registro DESC`;
        res.json({
            totalSocios: totalSocios.recordset[0].total,
            totalIngresos: totalIngresos.recordset[0].total,
            pagosMes: pagosMes.recordset[0].total,
            membresiasPopulares: membresiasPopulares.recordset,
            sociosRecientes: sociosRecientes.recordset
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// === CAJA CHICA ===
// === CAJA CHICA ===
app.get('/api/caja/resumen', auth, async (req, res) => {
    try {
        await sql.connect(db);
        const u = req.session.usuario;
        
        // 1. Buscamos a qué hora exacta fue tu ÚLTIMO cierre de caja
        const resCierre = await sql.query`SELECT ISNULL(MAX(fecha_cierre), '1900-01-01') as ultimo FROM CierreCaja WHERE usuario=${u}`;
        const ultimoCierre = resCierre.recordset[0].ultimo;

        // 2. Traemos totales y lista de pagos SOLAMENTE posteriores a ese último cierre
        const totales = await sql.query`
            SELECT 
                ISNULL(SUM(CASE WHEN p.metodo_pago = 'Efectivo' THEN p.monto ELSE 0 END), 0) as efec,
                ISNULL(SUM(CASE WHEN p.metodo_pago = 'Transferencia' THEN p.monto ELSE 0 END), 0) as trans
            FROM Pagos p
            JOIN Socios s ON p.socio_id=s.id
            WHERE s.usuario=${u} AND p.fecha_pago > ${ultimoCierre}`;

        const pagosHoy = await sql.query`
            SELECT p.id, s.nombre as socio, m.nombre as membresia,
            p.monto, p.metodo_pago, p.fecha_pago, p.fecha_vencimiento
            FROM Pagos p
            JOIN Socios s ON p.socio_id=s.id
            JOIN Membresias m ON p.membresia_id=m.id
            WHERE s.usuario=${u} AND p.fecha_pago > ${ultimoCierre}
            ORDER BY p.fecha_pago DESC`;
            
        res.json({
            efectivo: totales.recordset[0].efec,
            transferencia: totales.recordset[0].trans,
            total: parseFloat(totales.recordset[0].efec) + parseFloat(totales.recordset[0].trans),
            pagosHoy: pagosHoy.recordset
        });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/caja/cierre', auth, async (req, res) => {
    const { observaciones } = req.body;
    try {
        await sql.connect(db);
        const u = req.session.usuario;
        
        // Verificamos de nuevo el último cierre para no cobrar doble
        const resCierre = await sql.query`SELECT ISNULL(MAX(fecha_cierre), '1900-01-01') as ultimo FROM CierreCaja WHERE usuario=${u}`;
        const ultimoCierre = resCierre.recordset[0].ultimo;

        const totales = await sql.query`
            SELECT 
                ISNULL(SUM(CASE WHEN p.metodo_pago = 'Efectivo' THEN p.monto ELSE 0 END), 0) as efec,
                ISNULL(SUM(CASE WHEN p.metodo_pago = 'Transferencia' THEN p.monto ELSE 0 END), 0) as trans
            FROM Pagos p
            JOIN Socios s ON p.socio_id = s.id
            WHERE s.usuario = ${u} AND p.fecha_pago > ${ultimoCierre}`;
            
        const totalEfectivo = parseFloat(totales.recordset[0].efec);
        const totalTransferencia = parseFloat(totales.recordset[0].trans);
        const totalGeneral = totalEfectivo + totalTransferencia;

        // Si el total es 0, evitamos crear cierres vacíos
        if (totalGeneral === 0) {
            return res.status(400).json({ error: 'No hay pagos nuevos para cerrar la caja.' });
        }

        await sql.query`
            INSERT INTO CierreCaja (usuario, total_efectivo, total_transferencia, total_general, observaciones, fecha_cierre)
            VALUES (${u}, ${totalEfectivo}, ${totalTransferencia}, ${totalGeneral}, ${observaciones}, GETDATE())`;
            
        res.json({ mensaje: 'Cierre de caja exitoso' });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/caja/historial', auth, async (req, res) => {
    try {
        await sql.connect(db);
        const u = req.session.usuario;
        // Obligamos a SQL a devolver la fecha como texto exacto (sin zona horaria)
        const r = await sql.query`
            SELECT id, total_efectivo, total_transferencia, total_general, observaciones,
            CONVERT(varchar(19), fecha_cierre, 126) as fecha_cierre_str 
            FROM CierreCaja 
            WHERE usuario=${u}
            ORDER BY fecha_cierre DESC`;
        res.json(r.recordset);
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/caja/cierre', auth, async (req, res) => {
    const { observaciones } = req.body;
    try {
        await sql.connect(db);
        const efectivo = await sql.query`
            SELECT ISNULL(SUM(p.monto),0) as total FROM Pagos p
            JOIN Socios s ON p.socio_id=s.id
            WHERE s.usuario=${req.session.usuario}
            AND p.metodo_pago='Efectivo'
            AND CAST(p.fecha_pago AS DATE)=CAST(GETDATE() AS DATE)`;
        const transferencia = await sql.query`
            SELECT ISNULL(SUM(p.monto),0) as total FROM Pagos p
            JOIN Socios s ON p.socio_id=s.id
            WHERE s.usuario=${req.session.usuario}
            AND p.metodo_pago='Transferencia'
            AND CAST(p.fecha_pago AS DATE)=CAST(GETDATE() AS DATE)`;
        const totalEfectivo = parseFloat(efectivo.recordset[0].total);
        const totalTransferencia = parseFloat(transferencia.recordset[0].total);
        const totalGeneral = totalEfectivo + totalTransferencia;
        await sql.query`
            INSERT INTO CierreCaja (usuario, total_efectivo, total_transferencia, total_general, observaciones)
            VALUES (${req.session.usuario}, ${totalEfectivo}, ${totalTransferencia}, ${totalGeneral}, ${observaciones})`;
        res.json({ mensaje: 'Cierre de caja realizado', totalEfectivo, totalTransferencia, totalGeneral });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/caja/historial', auth, async (req, res) => {
    try {
        await sql.connect(db);
        const r = await sql.query`
            SELECT * FROM CierreCaja WHERE usuario=${req.session.usuario}
            ORDER BY fecha_cierre DESC`;
        res.json(r.recordset);
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Dar de baja la suscripción activa de un socio (vencer su último pago)
app.put('/api/pagos/cancelar/:socio_id', auth, async (req, res) => {
    const { socio_id } = req.params;
    try {
        await sql.connect(db);
        
        // Buscamos el último pago de este socio y cambiamos su vencimiento a ayer
        // para que el sistema lo reconozca inmediatamente como "Vencido"
        await sql.query`
            UPDATE Pagos 
            SET fecha_vencimiento = DATEADD(day, -1, CAST(GETDATE() AS DATE)) 
            WHERE id = (
                SELECT TOP 1 id 
                FROM Pagos 
                WHERE socio_id = ${socio_id} 
                ORDER BY fecha_pago DESC
            )
        `;
        
        res.json({ mensaje: 'Suscripción dada de baja correctamente.' });
    } catch (e) { 
        res.status(500).json({ error: e.message }); 
    }
});
const ExcelJS = require('exceljs');
const PDFDocument = require('pdfkit');

// Exportar socios a Excel
app.get('/api/exportar/socios/excel', auth, async (req, res) => {
    try {
        await sql.connect(db);
        const r = await sql.query`SELECT * FROM Socios WHERE usuario=${req.session.usuario} ORDER BY fecha_registro DESC`;
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
        r.recordset.forEach(s => sheet.addRow({
            id: s.id, nombre: s.nombre, email: s.email,
            telefono: s.telefono || '-',
            fecha_registro: new Date(s.fecha_registro).toLocaleDateString('es-ES')
        }));
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=socios.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exportar pagos a Excel
app.get('/api/exportar/pagos/excel', auth, async (req, res) => {
    try {
        await sql.connect(db);
        const r = await sql.query`
            SELECT s.nombre as socio, m.nombre as membresia,
                   p.monto, p.metodo_pago, p.fecha_pago, p.fecha_vencimiento
            FROM Pagos p
            JOIN Socios s ON p.socio_id=s.id
            JOIN Membresias m ON p.membresia_id=m.id
            WHERE s.usuario=${req.session.usuario}
            ORDER BY p.fecha_pago DESC`;
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
        r.recordset.forEach(p => sheet.addRow({
            socio: p.socio, membresia: p.membresia,
            monto: parseFloat(p.monto).toFixed(2),
            metodo_pago: p.metodo_pago,
            fecha_pago: new Date(p.fecha_pago).toLocaleDateString('es-ES'),
            fecha_vencimiento: p.fecha_vencimiento ? new Date(p.fecha_vencimiento).toLocaleDateString('es-ES') : '-'
        }));
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.setHeader('Content-Disposition', 'attachment; filename=pagos.xlsx');
        await workbook.xlsx.write(res);
        res.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// Exportar socios a PDF
app.get('/api/exportar/socios/pdf', auth, async (req, res) => {
    try {
        await sql.connect(db);
        const r = await sql.query`SELECT * FROM Socios WHERE usuario=${req.session.usuario} ORDER BY fecha_registro DESC`;
        const doc = new PDFDocument({ margin: 40 });
        res.setHeader('Content-Type', 'application/pdf');
        res.setHeader('Content-Disposition', 'attachment; filename=socios.pdf');
        doc.pipe(res);
        doc.fontSize(20).fillColor('#e94560').text('GymManager - Lista de Socios', { align: 'center' });
        doc.moveDown();
        doc.fontSize(10).fillColor('#888').text(`Generado: ${new Date().toLocaleDateString('es-ES')}`, { align: 'center' });
        doc.moveDown();
        doc.fontSize(11).fillColor('#333');
        r.recordset.forEach((s, i) => {
            doc.fillColor(i % 2 === 0 ? '#f9f9f9' : '#ffffff')
               .rect(40, doc.y, 520, 22).fill();
            doc.fillColor('#333').text(`${s.nombre}   |   ${s.email}   |   ${s.telefono || '-'}   |   ${new Date(s.fecha_registro).toLocaleDateString('es-ES')}`, 45, doc.y - 18);
            doc.moveDown(0.5);
        });
        doc.end();
    } catch (e) { res.status(500).json({ error: e.message }); }
});
// Servir archivos estáticos
app.use(express.static('public'));

const server = app.listen(3000, () => console.log('Servidor corriendo en http://localhost:3000'));
server.on('error', (e) => console.log('Error:', e.message));
process.stdin.resume();