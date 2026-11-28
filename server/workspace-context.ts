import { AsyncLocalStorage } from 'node:async_hooks';

export type Workspace = {
  id: number; code: string; name: string; kind: 'CAMPUS' | 'RETAIL'; status: 'ACTIVE' | 'PAUSED'; timezone: string;
};
const context = new AsyncLocalStorage<Workspace | null>();
export const defaultCampus: Workspace = { id: 1, code: 'CAMPUS', name: 'Campus', kind: 'CAMPUS', status: 'ACTIVE', timezone: process.env.APP_TZ || 'Asia/Kolkata' };
export const currentWorkspace = () => context.getStore() ?? defaultCampus;
export const workspaceId = () => currentWorkspace().id;
export const inWorkspace = <T>(workspace: Workspace, fn: () => T) => context.run(workspace, fn);
export const outsideWorkspace = <T>(fn: () => T) => context.run(null, fn);

export const workspaceTables = [
  'users', 'students', 'customers', 'hostels', 'services', 'orders', 'order_events', 'order_signoffs',
  'confirm_requests', 'handover_requests', 'complaints', 'complaint_updates', 'notifications', 'announcements',
  'files', 'activity', 'login_challenges', 'workspace_settings', 'workspace_counters',
] as const;
const scopedTables = new Set<string>(workspaceTables);

// Only names of tables in application-authored SQL reach this function. Bound parameters
// stay outside the SQL text. A CTE shadows each business table read by a scoped statement,
// including joins, nested queries and lookups by primary key.
export function scopeReads(sql: string, schema: 'main' | 'public') {
  const workspace = context.getStore();
  if (!workspace) return sql;
  const names = new Set<string>();
  for (const match of sql.matchAll(/\b[a-z_][a-z_0-9]*\b/gi)) {
    const name = match[0].toLowerCase();
    if (scopedTables.has(name)) names.add(name);
  }
  if (!names.size) return sql;
  const id = Number(workspace.id);
  if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid workspace');
  const definitions = Array.from(names, table => {
    const physical = schema + '.' + table;
    let filter = 'workspace_id = ' + id;
    if (table === 'users') {
      filter = "(role = 'STUDENT' AND workspace_id = " + id + ") OR role = 'ADMIN' OR (role = 'STAFF' AND id IN (SELECT user_id FROM staff_workspaces WHERE workspace_id = " + id + '))';
    }
    return table + ' AS (SELECT * FROM ' + physical + ' WHERE ' + filter + ')';
  }).join(', ');
  return /^\s*WITH\s/i.test(sql) ? sql.replace(/^\s*WITH\s/i, 'WITH ' + definitions + ', ') : 'WITH ' + definitions + ' ' + sql;
}
