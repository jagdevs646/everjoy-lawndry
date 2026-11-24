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
  // Every multipart part is bounded, not just the file: text fields are kept in memory too.
  limits: { fileSize: 5 * 1024 * 1024, files: 1, fields: 10, fieldSize: 4 * 1024, fieldNameSize: 64, parts: 12, headerPairs: 50 },
  fileFilter: (_req, file, cb) => (types[file.mimetype] ? cb(null, true) : cb(new HttpError(400, 'Only photos (JPG, PNG, WEBP, HEIC) can be attached.'))),
});

/** The browser's content type is only a claim: check the file really starts like that kind of image. */
function looksLike(mime: string, b: Buffer) {
  const at = (i: number, ...bytes: number[]) => bytes.every((x, j) => b[i + j] === x);
  const ascii = (i: number, t: string) => b.subarray(i, i + t.length).toString('latin1') === t;
  switch (mime) {
    case 'image/jpeg': return at(0, 0xff, 0xd8, 0xff);
    case 'image/png': return at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
    case 'image/webp': return ascii(0, 'RIFF') && ascii(8, 'WEBP');
    case 'image/heic': case 'image/heif': return ascii(4, 'ftyp') && /^(heic|heix|hevc|hevx|heim|heis|mif1|msf1|avif)$/.test(b.subarray(8, 12).toString('latin1'));
    default: return false;
  }
}

/** Store an uploaded photo in the database and return its file name (what complaints.photo holds). */
export async function savePhoto(file: Express.Multer.File): Promise<string> {
  if (!looksLike(file.mimetype, file.buffer)) throw new HttpError(400, 'That file is not a photo. Attach a JPG, PNG, WEBP or HEIC picture.');
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
