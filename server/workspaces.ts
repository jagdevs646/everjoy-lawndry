import { Router } from 'express';
import { z } from 'zod';
import { requireRole } from './auth.js';
import type { NextFunction, Request, Response } from 'express';
import type { AuthedRequest } from './auth.js';
import { db, insertId, logActivity } from './db.js';
import { HttpError, handle, codeKey, nowIso, parse, zDate, zId } from './util.js';
import { inWorkspace, outsideWorkspace, type Workspace } from './workspace-context.js';

const publicColumns = 'id,code,name,kind,status,timezone';

export async function visibleWorkspaces(user: AuthedRequest['user'] | undefined): Promise<Workspace[]> {
  if (!user) return db.all(`SELECT ${publicColumns} FROM workspaces WHERE kind='CAMPUS' ORDER BY id`);
  if (user.role === 'ADMIN') return db.all(`SELECT ${publicColumns} FROM workspaces ORDER BY id`);
  if (user.role === 'STAFF') return db.all(`SELECT ${publicColumns} FROM workspaces WHERE id IN (SELECT workspace_id FROM staff_workspaces WHERE user_id=?) ORDER BY id`, [user.id]);
  return db.all(`SELECT ${publicColumns} FROM workspaces WHERE id=?`, [user.workspace_id]);
}

export async function selectWorkspace(req: Request, _res: Response, next: NextFunction) {
  try {
    const user = (req as AuthedRequest).user;
    if (['/health','/access/workspaces','/auth/logout'].includes(req.path)) return next();
    const requested = req.get('x-ej-workspace');
    let choices = await visibleWorkspaces(user);
    if (!user && req.path === '/auth/login') {
      // Staff have a single business login even when assigned to a different campus.
      const login = typeof req.body?.loginId === 'string' ? req.body.loginId.toUpperCase().replace(/\s+/g,'') : '';
      const accounts = await db.all<{role: string; workspace_id: number; id: number}>('SELECT role,workspace_id,id FROM users WHERE login_id=? ORDER BY id', [login]);
      const staff = accounts.find(a => a.role !== 'STUDENT');
      if (staff) return next(); // The password check and normal session middleware still apply.
      if (accounts.length > 1 && !requested) throw new HttpError(409, 'Which university?', {code:'CHOOSE_CAMPUS'});
      if (!requested && accounts.length === 1) choices = choices.filter(w => w.id === accounts[0].workspace_id);
    }
    if (!user && ['/auth/otp','/auth/otp/resend'].includes(req.path) && typeof req.body?.challenge === 'string') {
      const challenge = await db.get<{workspace_id: number}>('SELECT workspace_id FROM login_challenges WHERE id=?',[req.body.challenge]);
      if (challenge) choices = choices.filter(w => w.id === challenge.workspace_id);
    }
    const chosen = requested ? choices.find(w => String(w.id) === requested) : choices[0];
    if (!chosen && user && req.path === '/auth/me' && !requested) return next();
    if (!chosen) throw new HttpError(403, user ? 'No access here. Ask the admin.' : 'Choose a university.');
    return inWorkspace(chosen, next);
  } catch (error) { next(error); }
}

export async function assertOrderPrefix(workspace: number, prefix: string, suffix: string) {
  // Serialize changes to order formats with campus creation. Order keys also remain globally unique.
  if (db.dialect === 'postgres') await db.run('SELECT id FROM workspaces WHERE id=1 FOR UPDATE');
  const formats = await outsideWorkspace(() => db.all<{name:string;value:string|null}>(`SELECT w.name,s.value FROM workspaces w
    LEFT JOIN workspace_settings s ON s.workspace_id=w.id AND s.key='order_no_format' WHERE w.id != ?`, [workspace]));
  const part = (s: string) => codeKey(s.replace(/\{(?:YYYY|YY|MM|FY)\}/g,'0'));
  for (const other of formats) {
    const f = other.value ? JSON.parse(other.value) : {prefix:'EJ-',suffix:''};
    const a = part(prefix), b = part(f.prefix);
    const overlaps = a === b || (a.startsWith(b) && /^\d+$/.test(a.slice(b.length))) || (b.startsWith(a) && /^\d+$/.test(b.slice(a.length)));
    if (overlaps && part(suffix) === part(f.suffix)) throw new HttpError(409, 'Choose a different order prefix. This format overlaps ' + other.name + '.');
  }
}

export const workspaceRouter = Router();
workspaceRouter.use('/admin/workspaces', requireRole('ADMIN'));
const campusFields = {
  name: z.string().trim().min(2).max(80), code: z.string().trim().toUpperCase().regex(/^[A-Z][A-Z0-9]{1,11}$/),
  status: z.enum(['ACTIVE','PAUSED']).default('ACTIVE'), timezone: z.string().max(80).default('Asia/Kolkata').refine(tz => {
    try { new Intl.DateTimeFormat('en',{timeZone:tz}); return true; } catch { return false; }
  }, 'Choose a valid timezone'),
  contact_name: z.string().trim().max(100).default(''), contact_phone: z.string().trim().max(25).default(''),
  contract_from: zDate.or(z.literal('')).default(''), contract_until: zDate.or(z.literal('')).default(''),
  monthly_value: z.number().nonnegative().max(1e12).nullable().default(null), notes: z.string().trim().max(2000).default(''),
};
const schema = z.object(campusFields);
const datesValid = (b:{contract_from:string;contract_until:string}) => !b.contract_until || !b.contract_from || b.contract_until >= b.contract_from;

workspaceRouter.post('/admin/workspaces', handle(async (req,res) => {
  const b = parse(schema.extend({copy_from:zId.default(1),hostels:z.array(z.string().trim().min(1).max(40)).max(200).default([])}).refine(datesValid,'Check the contract dates'),req.body);
  const result = await outsideWorkspace(() => db.tx(async () => {
    if (!await db.get("SELECT id FROM workspaces WHERE kind='CAMPUS' AND id=?", [b.copy_from])) throw new HttpError(400,'Choose a source campus.');
    if (await db.get('SELECT id FROM workspaces WHERE code=?',[b.code])) throw new HttpError(409,'This campus code is in use.');
    await assertOrderPrefix(0,b.code+'-','');
    const id = await insertId(`INSERT INTO workspaces(kind,name,code,status,timezone,contact_name,contact_phone,contract_from,contract_until,monthly_value,notes)
      VALUES ('CAMPUS',?,?,?,?,?,?,?,?,?,?)`,[b.name,b.code,b.status,b.timezone,b.contact_name,b.contact_phone,b.contract_from,b.contract_until,b.monthly_value,b.notes]);
    await db.run(`INSERT INTO workspace_settings(workspace_id,key,value,updated_at,updated_by)
      SELECT ?,key,value,updated_at,updated_by FROM workspace_settings WHERE workspace_id=? AND key NOT IN ('order_no_format','upi_qr_file')`, [id,b.copy_from]);
    await db.run("INSERT INTO workspace_settings(workspace_id,key,value,updated_at) VALUES (?,'order_no_format',?,?)",
      [id,JSON.stringify({prefix:b.code+'-',suffix:'',start:1001,pad:0,reset:'NEVER'}),nowIso()]);
    await db.run(`INSERT INTO services(workspace_id,name,unit,rate,hosteler_rate,uses_allowance,active,sort,created_at)
      SELECT ?,name,unit,rate,hosteler_rate,uses_allowance,active,sort,created_at FROM services WHERE workspace_id=?`,[id,b.copy_from]);
    for (const hostel of b.hostels) await db.run('INSERT INTO hostels(workspace_id,name) VALUES (?,?)',[id,hostel]);
    await inWorkspace({id,kind:'CAMPUS',...b},()=>logActivity((req as AuthedRequest).user.id,'CAMPUS_CREATED','workspace',id,b.name));
    return { id };
  }));
  res.status(201).json(result);
}));

workspaceRouter.patch('/admin/workspaces/:id', handle(async (req,res) => {
  const id = parse(zId,req.params.id);
  const old = await db.get<Workspace & Record<string,unknown>>('SELECT * FROM workspaces WHERE id=?',[id]);
  if (!old) throw new HttpError(404,'Workspace not found.');
  const b = parse(schema.refine(datesValid,'Check the contract dates'),{...Object.fromEntries(Object.entries(old).filter(([,v])=>v!==null)),...req.body});
  if (await db.get('SELECT id FROM workspaces WHERE code=? AND id!=?',[b.code,id])) throw new HttpError(409,'This workspace code is in use.');
  await db.tx(async () => {
    await db.run(`UPDATE workspaces SET name=?,code=?,status=?,timezone=?,contact_name=?,contact_phone=?,contract_from=?,contract_until=?,monthly_value=?,notes=? WHERE id=?`,
      [b.name,b.code,b.status,b.timezone,b.contact_name,b.contact_phone,b.contract_from,b.contract_until,b.monthly_value,b.notes,id]);
    await inWorkspace(old,()=>logActivity((req as AuthedRequest).user.id,'WORKSPACE_UPDATED','workspace',id,b.name));
  });
  res.json({ok:true});
}));
