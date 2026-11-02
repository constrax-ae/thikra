/** One CSV cell: quoted, quotes doubled, and a leading = + - @ (or tab/return) defused so a spreadsheet never runs it as a formula. */
export const csvCell = (v: unknown) => { let s = v === null || v === undefined ? '' : String(v); if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
export const toCsv = (headers: string[], rows: unknown[][]) => '﻿' + [headers.join(','), ...rows.map(r => r.map(csvCell).join(','))].join('\n');
export const csvResponse = (name: string, body: string) => new Response(body, { headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}-${new Date().toISOString().slice(0, 10)}.csv"` } });
