/**
 * Spreadsheet-style frame for the office tables (Register, Students, Staff, Activity log):
 * a page of rows (100 by default, any number up to 1,000), page buttons, columns you can drag
 * wider or narrower, row height, and wrap text on/off. Each table remembers its own choices
 * on this computer. On phones the tables show as cards, so only the paging applies there.
 */
import { ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Icon } from './ui';

type RowHeight = 'compact' | 'normal' | 'tall';
type Prefs = { size: number; height: RowHeight; wrap: boolean; widths: Record<number, number> };
const DEFAULTS: Prefs = { size: 100, height: 'normal', wrap: false, widths: {} };
const MIN_SIZE = 10, MAX_SIZE = 1000, MIN_COL = 48;

const key = (id: string) => `ej-grid:${id}`;
function loadPrefs(id: string, start: Partial<Prefs> = {}): Prefs {
  try { return { ...DEFAULTS, ...start, ...JSON.parse(localStorage.getItem(key(id)) || '{}') }; } catch { return { ...DEFAULTS, ...start }; }
}
function savePrefs(id: string, p: Prefs) {
  try { localStorage.setItem(key(id), JSON.stringify(p)); } catch { /* private mode: not remembered */ }
}
const wide = () => window.matchMedia('(min-width: 761px)').matches;

/** Page and rows-per-page for one table. `resetOn` (filters, search) goes back to page 1. */
export function useGrid(id: string, resetOn: unknown[] = [], start: Partial<Prefs> = {}) {
  const [prefs, setPrefsRaw] = useState<Prefs>(() => loadPrefs(id, start));
  const [page, setPage] = useState(0);
  const setPrefs = (p: Partial<Prefs>) => setPrefsRaw(cur => { const next = { ...cur, ...p }; savePrefs(id, next); return next; });
  useEffect(() => setPage(0), resetOn);   // eslint-disable-line react-hooks/exhaustive-deps
  return { id, prefs, setPrefs, page, setPage, size: prefs.size, offset: page * prefs.size };
}
export type Grid = ReturnType<typeof useGrid>;

/** The rows per page box: type a number, it applies when you press Enter or leave the box. */
function SizeBox({ value, onChange }: { value: number; onChange: (n: number) => void }) {
  const [text, setText] = useState(String(value));
  useEffect(() => setText(String(value)), [value]);
  const commit = () => {
    const n = Math.min(MAX_SIZE, Math.max(MIN_SIZE, Math.round(Number(text) || value)));
    setText(String(n));
    if (n !== value) onChange(n);
  };
  return (
    <label className="grid-size">Rows per page
      <input type="number" inputMode="numeric" min={MIN_SIZE} max={MAX_SIZE} step={10} value={text}
        onChange={e => setText(e.target.value)} onBlur={commit} onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); commit(); } }}
        aria-label="Rows per page" />
    </label>
  );
}

function Pager({ grid, total }: { grid: Grid; total: number }) {
  const pages = Math.max(1, Math.ceil(total / grid.size));
  const first = total ? grid.offset + 1 : 0;
  const last = Math.min(total, grid.offset + grid.size);
  // A shorter list after a filter: don't stay on a page that no longer exists.
  useEffect(() => { if (grid.page > 0 && grid.page >= pages) grid.setPage(pages - 1); }, [pages]);   // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="grid-pager">
      <span className="grid-count">{total ? <>{first.toLocaleString('en-IN')}–{last.toLocaleString('en-IN')} of <b>{total.toLocaleString('en-IN')}</b></> : 'Nothing to show'}</span>
      <Button size="sm" tone="plain" icon="back" disabled={grid.page === 0} onClick={() => grid.setPage(grid.page - 1)} aria-label="Previous page">Prev</Button>
      <span className="small">Page {grid.page + 1} of {pages}</span>
      <Button size="sm" tone="plain" disabled={grid.page + 1 >= pages} onClick={() => grid.setPage(grid.page + 1)} aria-label="Next page">Next <Icon name="next" size={16} /></Button>
    </div>
  );
}

/**
 * Wraps a `<table className="ledger">`: toolbar above (rows per page, row height, wrap, reset
 * widths, page buttons), drag handles on the column headers, and page buttons below a long page.
 */
export function GridFrame({ grid, total, shown, children, extra }: { grid: Grid; total: number; shown: number; children: ReactNode; extra?: ReactNode }) {
  const box = useRef<HTMLDivElement>(null);
  const { prefs, setPrefs } = grid;
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // Column widths: applied to the header cells; the table switches to fixed layout once any is set.
  const applyWidths = (widths: Record<number, number>) => {
    const table = box.current?.querySelector('table');
    if (!table) return;
    const ths = [...table.querySelectorAll<HTMLTableCellElement>('thead th')];
    const fixed = wide() && Object.keys(widths).length > 0;
    if (!fixed) {
      table.style.tableLayout = ''; table.style.width = ''; table.style.minWidth = '';
      ths.forEach(th => { th.style.width = ''; });
      return;
    }
    // Columns not set yet keep the width they have now, so nothing jumps.
    const current = ths.map(th => th.getBoundingClientRect().width);
    let sum = 0;
    ths.forEach((th, i) => { const w = Math.max(MIN_COL, Math.round(widths[i] ?? current[i])); th.style.width = `${w}px`; sum += w; });
    table.style.tableLayout = 'fixed';
    table.style.width = `${sum}px`;
    table.style.minWidth = '0';
  };

  // Drag handles on every header (added once per header cell; the table re-renders often).
  useLayoutEffect(() => {
    const table = box.current?.querySelector('table');
    if (!table) return;
    const ths = [...table.querySelectorAll<HTMLTableCellElement>('thead th')];
    ths.forEach((th, i) => {
      if (th.querySelector(':scope > .col-resize')) return;
      const handle = document.createElement('span');
      handle.className = 'col-resize';
      handle.title = 'Drag to resize. Double-click to reset.';
      handle.setAttribute('aria-hidden', 'true');
      handle.addEventListener('pointerdown', (e: PointerEvent) => {
        if (!wide()) return;
        e.preventDefault();
        e.stopPropagation();
        try { handle.setPointerCapture(e.pointerId); } catch { /* the page-wide listeners below still follow the pointer */ }
        const startX = e.clientX;
        // Freeze the current widths of all columns first.
        const all = Object.fromEntries(ths.map((t, j) => [j, prefsRef.current.widths[j] ?? t.getBoundingClientRect().width]));
        const startW = all[i];
        document.body.classList.add('col-resizing');
        const move = (m: PointerEvent) => { all[i] = Math.max(MIN_COL, startW + m.clientX - startX); applyWidths(all); };
        const up = (u: PointerEvent) => {
          move(u);
          window.removeEventListener('pointermove', move);
          window.removeEventListener('pointerup', up);
          window.removeEventListener('pointercancel', up);
          document.body.classList.remove('col-resizing');
          setPrefs({ widths: Object.fromEntries(Object.entries(all).map(([k, v]) => [k, Math.round(v)])) });
        };
        window.addEventListener('pointermove', move);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
      });
      handle.addEventListener('dblclick', e => {
        e.stopPropagation();
        const next = { ...prefsRef.current.widths };
        delete next[i];
        setPrefs({ widths: next });
      });
      handle.addEventListener('click', e => e.stopPropagation());
      th.appendChild(handle);
    });
    applyWidths(prefs.widths);
  });
  useEffect(() => {
    const onResize = () => applyWidths(prefsRef.current.widths);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);   // eslint-disable-line react-hooks/exhaustive-deps

  const hasWidths = Object.keys(prefs.widths).length > 0;
  return (
    <div className="grid-frame">
      <div className="grid-tools" role="toolbar" aria-label="Table view">
        <Pager grid={grid} total={total} />
        <div className="grid-view">
          <SizeBox value={prefs.size} onChange={size => { setPrefs({ size }); grid.setPage(0); }} />
          <label className="grid-select">Row height
            <select value={prefs.height} onChange={e => setPrefs({ height: e.target.value as RowHeight })}>
              <option value="compact">Compact</option><option value="normal">Normal</option><option value="tall">Tall</option>
            </select>
          </label>
          <label className="check-line grid-wrap-toggle"><input type="checkbox" checked={prefs.wrap} onChange={e => setPrefs({ wrap: e.target.checked })} />Wrap text</label>
          {hasWidths && <Button size="sm" tone="plain" onClick={() => setPrefs({ widths: {} })}>Reset column widths</Button>}
          {extra}
        </div>
      </div>
      <div ref={box} className={`ledger-wrap grid rows-${prefs.height} ${prefs.wrap ? 'wrap' : 'nowrap'}${hasWidths ? ' sized' : ''}`}>
        {children}
      </div>
      {shown > 20 && <div className="grid-tools bottom"><Pager grid={grid} total={total} /></div>}
    </div>
  );
}
