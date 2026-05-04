require('dotenv').config(); // Load environment variables
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const multer = require('multer');
const nodemailer = require('nodemailer');
const fs = require('fs-extra');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');

const app = express();
const PORT = 3000;

// Middleware
app.use(compression()); // Compress responses
app.use(helmet({
    contentSecurityPolicy: false, // Allow inline scripts/styles/external CDNs
    crossOriginEmbedderPolicy: false
}));
app.use(morgan('dev')); // Logging
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '50mb' }));

// Storage setup
const DB_FILE = path.join(__dirname, 'db.json');
const CERTS_DIR = path.join(__dirname, 'certificates');

// Ensure directories exist
fs.ensureDirSync(CERTS_DIR);
if (!fs.existsSync(DB_FILE)) {
    fs.writeJsonSync(DB_FILE, []);
}

// Multer for file uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        cb(null, CERTS_DIR);
    },
    filename: (req, file, cb) => {
        cb(null, `${Date.now()}-${file.originalname}`);
    }
});
const upload = multer({ storage });

// Helper to read/write DB
const getDB = () => fs.readJsonSync(DB_FILE);
const saveDB = (data) => fs.writeJsonSync(DB_FILE, data, { spaces: 2 });

// Configure Transporter (Reuse connection)
let transporter = null;
const initTransporter = () => {
    if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
        transporter = nodemailer.createTransport({
            host: process.env.SMTP_HOST,
            port: process.env.SMTP_PORT || 587,
            secure: process.env.SMTP_PORT == 465, // true for 465, false for other ports
            auth: {
                user: process.env.SMTP_USER,
                pass: process.env.SMTP_PASS
            }
        });
        console.log('[Server] SMTP Transporter Configured for ' + process.env.SMTP_USER);
    } else {
        console.warn('[Server] No SMTP credentials found in .env. Email dispatch will be SIMULATED.');
    }
};
initTransporter();

// --- Endpoints ---

// 1. Save Certificate
app.post('/api/certificates', upload.single('pdf'), async (req, res) => {
    try {
        const { name, email, course, uuid, certId } = req.body;
        const file = req.file;

        if (!file) {
            return res.status(400).json({ success: false, message: 'No PDF file uploaded' });
        }

        const db = getDB();
        const newCert = {
            id: uuid || certId || uuidv4(),
            uuid: uuid || certId || uuidv4(),
            name,
            email,
            course,
            pdfPath: file.filename, // Store filename, serve via static route
            status: 'pending', // Dispatch status
            generatedDate: new Date().toISOString(),
            sentDate: null,
            openedDate: null,
            retryCount: 0
        };

        // Check for duplicates (optional, based on UUID)
        const existingIndex = db.findIndex(c => c.uuid === newCert.uuid);
        if (existingIndex > -1) {
            // Update existing? Or skip? Let's update for now so we have the latest file
            db[existingIndex] = { ...db[existingIndex], ...newCert, status: db[existingIndex].status }; // Keep old status if exists? 
            // Actually, if we re-generate, we might want to reset status or keep it. 
            // Requirement says "prevent duplicate entries". Let's overwrite metadata but keep status if it was sent.
            if (db[existingIndex].status === 'sent') {
                newCert.status = 'sent';
                newCert.sentDate = db[existingIndex].sentDate;
            }
            db[existingIndex] = newCert;
        } else {
            db.push(newCert);
        }

        saveDB(db);

        res.json({ success: true, certificate: newCert });
    } catch (error) {
        console.error('Error saving certificate:', error);
        res.status(500).json({ success: false, message: 'Internal server error' });
    }
});

// 2. Get All Certificates
app.get('/api/certificates', (req, res) => {
    try {
        const db = getDB();
        res.json(db);
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// 3. Dispatch Email
app.post('/api/dispatch', async (req, res) => {
    const { id, email, name, course, certificate_link, smtpConfig } = req.body;

    // Determine which Transporter to use
    let activeTransporter = transporter; // Default to env config
    let senderEmail = process.env.SMTP_USER; // Default sender

    // If Dynamic Credentials Provided
    if (smtpConfig && smtpConfig.email && smtpConfig.password) {
        try {
            console.log(`[Server] Configuring Dynamic Transporter for ${smtpConfig.email}...`);
            activeTransporter = nodemailer.createTransport({
                host: "smtp.gmail.com", // Defaulting to Gmail for now, or could pass host
                port: 465, // SSL
                secure: true,
                auth: {
                    user: smtpConfig.email,
                    pass: smtpConfig.password
                },
                pool: true, // Use pooling to prevent rate limits
                maxConnections: 1,
                maxMessages: 10
            });
            senderEmail = smtpConfig.email;
        } catch (e) {
            console.warn("[Server] Failed to create dynamic transporter:", e);
            // Fallback? Or fail? Let's fail if they explicitly tried active credentials.
            return res.status(400).json({ success: false, message: "Invalid SMTP Credentials provided." });
        }
    } else {
        // Refresh config if changed/added at runtime and no dynamic auth provided
        if (!activeTransporter) initTransporter();

        if (!activeTransporter) {
            console.error('[Server] SMTP NOT CONFIGURED. Dispatch failed.');
            return res.status(500).json({
                success: false,
                message: 'SMTP not configured. Real email required.'
            });
        }
    }

    try {
        const db = getDB();
        const index = db.findIndex(c => c.id === id || c.uuid === id);

        if (index === -1) {
            return res.status(404).json({ success: false, message: 'Certificate not found' });
        }

        if (activeTransporter) {
            // Real Email Dispatch
            const mailOptions = {
                from: `"CertVerify Pro" <${senderEmail}>`,
                to: email,
                subject: `Your Certificate for ${course || 'Course Completion'}`,
                html: `
                    <div style="font-family: Arial, sans-serif; padding: 20px; background-color: #f4f4f4;">
                        <div style="background-color: white; padding: 30px; border-radius: 8px; box-shadow: 0 2px 5px rgba(0,0,0,0.1);">
                            <h2 style="color: #2563EB;">Congratulations, ${name}!</h2>
                            <p>You have successfully completed <strong>${course}</strong>.</p>
                            <p>Your certificate is ready for verification and download.</p>
                            <div style="margin: 30px 0; text-align: center;">
                                <a href="${certificate_link}" style="background-color: #2563EB; color: white; padding: 12px 24px; text-decoration: none; border-radius: 5px; font-weight: bold;">View Certificate</a>
                            </div>
                            <p style="font-size: 12px; color: #666;">If the button doesn't work, copy this link: ${certificate_link}</p>
                            <hr style="border: 0; border-top: 1px solid #eee; margin: 20px 0;">
                            <p style="font-size: 11px; color: #999; text-align: center;">Sent by ${senderEmail}</p>
                        </div>
                    </div>
                `
            };

            // Attach PDF if available locally? 
            // The file is on the server.
            const certFilename = db[index].pdfPath;
            if (certFilename) {
                const filePath = path.join(CERTS_DIR, certFilename);
                if (fs.existsSync(filePath)) {
                    mailOptions.attachments = [{
                        filename: `Certificate-${name.replace(/\s+/g, '_')}.pdf`,
                        path: filePath
                    }];
                }
            }

            // Verify connection before sending (Optional but good for debugging dynamic auth)
            try {
                await activeTransporter.verify();
            } catch (verifyErr) {
                console.error("[Server] SMTP Authentication Failed:", verifyErr);
                return res.status(401).json({ success: false, message: "SMTP Auth Failed: Check App Password." });
            }

            const info = await activeTransporter.sendMail(mailOptions);
            console.log(`[Server] Email sent: ${info.messageId} from ${senderEmail}`);

            // Log success details?
            // Log success details?
        }

        // Update DB
        db[index].status = 'sent';
        db[index].sentDate = new Date().toISOString();
        saveDB(db);

        res.json({ success: true, message: transporter ? 'Email sent successfully via SMTP' : 'Email simulated (No SMTP Config)' });

    } catch (error) {
        console.error('Dispatch error:', error);
        res.status(500).json({ success: false, message: 'Failed to send email: ' + error.message });
    }
});

// 4. Verify Certificate (Public View)
app.get('/api/verify/:id', (req, res) => {
    try {
        const { id } = req.params;
        const db = getDB();
        const cert = db.find(c => c.uuid === id || c.id === id);

        if (cert) {
            // Update Opened Status if not the admin viewing (hard to tell, but we can assume verification = open)
            if (cert.status !== 'opened' && cert.status !== 'sent') {
                // strictly speaking, usually verification links trigger 'opened'
            }
            // Actually, usually we have a specific pixel or link for "opened".
            // Verification page is fine to trigger it too.
            if (cert.status === 'sent') { // Only mark opened if it was sent
                cert.status = 'opened';
                cert.openedDate = new Date().toISOString();
                // update db
                const idx = db.indexOf(cert);
                db[idx] = cert;
                saveDB(db);
            }
            res.json({ success: true, certificate: cert });
        } else {
            res.status(404).json({ success: false, message: 'Certificate not found' });
        }
    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// Serve static certificates
app.use('/certificates', express.static(CERTS_DIR));

// Start server
app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});
