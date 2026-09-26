import { z } from 'zod';

// Calendar boundaries are built in the browser's timezone, including DST changes.
export function weekBoundaries(today = new Date()): string[] {
  return Array.from({ length: 8 }, (_, index) => {
    const day = new Date(today);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - 6 + index);
    return day.toISOString();
  });
}

export const weekBoundariesSchema = z.array(z.iso.datetime()).length(8).refine(days =>
  days.every((day, index) => {
    if (index === 0) return true;
    const hours = (Date.parse(day) - Date.parse(days[index - 1])) / 3600000;
    return hours >= 20 && hours <= 28;
  }), 'Expected seven consecutive calendar days',
);

// Other pages keep their existing data contract until their own performance task.
export function overviewOnly(pathname: string) {
  return !['/leads', '/search', '/history', '/credits', '/admin/members', '/admin/activity'].includes(pathname);
}
