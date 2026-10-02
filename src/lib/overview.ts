// Calendar boundaries are built in the browser's timezone, including DST changes.
export function weekBoundaries(today = new Date()): string[] {
  return Array.from({ length: 8 }, (_, index) => {
    const day = new Date(today);
    day.setHours(0, 0, 0, 0);
    day.setDate(day.getDate() - 6 + index);
    return day.toISOString();
  });
}

// Other pages keep their existing data contract until their own performance task.
export function overviewOnly(pathname: string) {
  return !['/crm', '/leads', '/search', '/history', '/credits', '/admin/members', '/admin/activity'].includes(pathname);
}
