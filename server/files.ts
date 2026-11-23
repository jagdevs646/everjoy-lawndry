import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { db } from './db.js';
import type { AuthedRequest } from './auth.js';
import { HttpError, handle } from './util.js';

export const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');
fs.mkdirSync(uploadDir, { recursive: true });

const types: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif' };

export const photoUpload = multer({
  storage: multer.diskStorage({
    destination: uploadDir,
    filename: (_req, file, cb) => cb(null, crypto.randomBytes(16).toString('hex') + (types[file.mimetype] || '.img')),
  }),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (types[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Only photos (JPG, PNG, WEBP, HEIC) can be attached.'))),
});

/** Complaint photos are private: only staff/admin or the student who raised it may open them. */
export const serveFile = handle((req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user) throw new HttpError(401, 'Please sign in.');
  const name = path.basename(String(req.params.name));
  const owner = db.prepare('SELECT student_id FROM complaints WHERE photo = ?').get(name) as { student_id: number } | undefined;
  if (!owner) throw new HttpError(404, 'File not found.');
  if (user.role === 'STUDENT' && owner.student_id !== user.id) throw new HttpError(403, 'You do not have access to this file.');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(path.join(uploadDir, name));
});
