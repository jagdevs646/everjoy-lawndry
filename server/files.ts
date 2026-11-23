import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import multer from 'multer';
import { db } from './db.js';
import type { AuthedRequest } from './auth.js';
import { HttpError, handle, nowIso } from './util.js';

/**
 * Complaint photos live in the database (files table), so they survive hosts whose disk is
 * wiped on restart (e.g. Render's free tier). This folder is only read as a fallback for photos
 * saved to disk by older local installs; nothing is written to it any more.
 */
export const uploadDir = path.resolve(process.env.UPLOAD_DIR || 'uploads');

const types: Record<string, string> = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp', 'image/heic': '.heic', 'image/heif': '.heif' };

export const photoUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
  fileFilter: (_req, file, cb) => (types[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Only photos (JPG, PNG, WEBP, HEIC) can be attached.'))),
});

/** Store an uploaded photo in the database and return its file name (what complaints.photo holds). */
export async function savePhoto(file: Express.Multer.File): Promise<string> {
  const name = crypto.randomBytes(16).toString('hex') + (types[file.mimetype] || '.img');
  await db.run('INSERT INTO files (name, mime, data, created_at) VALUES (?,?,?,?)', [name, file.mimetype, file.buffer, nowIso()]);
  return name;
}

/** True when an old on-disk upload with this name exists. */
async function onDisk(file: string) {
  try { return (await fs.promises.stat(file)).isFile(); } catch { return false; }
}

/** Complaint photos are private: only staff/admin or the student who raised it may open them. */
export const serveFile = handle(async (req, res) => {
  const user = (req as AuthedRequest).user;
  if (!user) throw new HttpError(401, 'Please sign in.');
  const name = path.basename(String(req.params.name));
  const owner = await db.get<{ student_id: number }>('SELECT student_id FROM complaints WHERE photo = ?', [name]);
  if (!owner) throw new HttpError(404, 'File not found.');
  if (user.role === 'STUDENT' && owner.student_id !== user.id) throw new HttpError(403, 'You do not have access to this file.');
  const row = await db.get<{ mime: string; data: Buffer | Uint8Array }>('SELECT mime, data FROM files WHERE name = ?', [name]);
  if (row) {
    res.setHeader('Cache-Control', 'private, max-age=3600');
    res.type(row.mime).send(Buffer.from(row.data));
    return;
  }
  // Photos from older local installs were saved to disk.
  const legacy = path.join(uploadDir, name);
  if (!(await onDisk(legacy))) throw new HttpError(404, 'File not found.');
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.sendFile(legacy);
});
