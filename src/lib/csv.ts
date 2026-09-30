import { Contact, emailTrust } from './contracts';
export function cell(value: string) {
  const safe = /^[=+\-@\t\r]/.test(value) ? "'" + value : value;
  return '"' + safe.replaceAll('"', '""') + '"';
}
export function contactsCsv(contacts: Contact[]) {
  const headers = ['First Name', 'Last Name', 'Email', 'Company Name', 'Job Title', 'City', 'Country', 'Website', 'Source', 'Email Status'];
  // Source is the platform, never the data provider (owner's decision 2026-09-30), old rows included.
  const rows = contacts.map(c => {
    const [first, ...rest] = c.name.split(' ');
    return [first, rest.join(' '), c.email, c.company, c.title, c.city, c.country, c.website, c.email_status === 'demo' ? c.source : 'clowzy', c.email_status === 'demo' ? 'DEMO — not real contact data' : emailTrust(c.email_status)];
  });
  return '\uFEFF' + [headers, ...rows].map(row => row.map(cell).join(',')).join('\r\n');
}
