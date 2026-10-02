import { Contact, emailTrust } from './contracts';
export function cell(value: string) {
  const safe = /^[=+\-@\t\r\n]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
export function contactsCsv(contacts: Contact[]) {
  const headers = ['First Name', 'Last Name', 'Email', 'Company Name', 'Job Title', 'City', 'Country', 'Website', 'Source', 'Email Status'];
  // Source is the platform, never the data provider (owner's decision 2026-09-30), old rows included.
  const rows = contacts.map(c => {
    const [first, ...rest] = c.kind === 'company' ? [''] : c.name.split(' '); // a company's own email has no person name
    return [first, rest.join(' '), c.email, c.company, c.title, c.city, c.country, c.website, c.email_status === 'demo' ? c.source : 'clowzy', c.email_status === 'demo' ? 'DEMO — not real contact data' : emailTrust(c.email_status)];
  });
  return '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}

export const exportColumns = ['name','email','company','title','city','country','website','kind','stage','tags','notes'] as const;
export type ExportColumn = typeof exportColumns[number];
export function crmCsv(contacts:(Contact & {stage?:string;tags?:string[];notes?:string})[],columns:ExportColumn[],profile:'generic'|'gohighlevel') {
  const names:Record<ExportColumn,string>={name:'Name',email:'Email',company:'Company Name',title:'Job Title',city:'City',country:'Country',website:'Website',kind:'Contact Type',stage:'Stage',tags:'Tags',notes:'Notes'};
  const headers=columns.flatMap(k=>profile==='gohighlevel'&&k==='name'?['First Name','Last Name']:[profile==='gohighlevel'&&k==='company'?'Business Name':names[k]]);
  const rows=contacts.map(c=>columns.flatMap(k=>{
    if(k==='name'&&profile==='gohighlevel'){const [first,...last]=c.kind==='company'?['']:c.name.split(' ');return [first,last.join(' ')];}
    return [k==='tags'?(c.tags||[]).join(', '):k==='stage'?(c.stage||'new'):k==='kind'?(c.kind||'person'):String(c[k]||'')];
  }));
  return '\uFEFF'+[headers,...rows].map(row=>row.map(cell).join(',')).join('\r\n');
}
