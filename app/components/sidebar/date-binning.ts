import { format, isAfter, isThisWeek, isThisYear, isToday, isYesterday, subDays } from 'date-fns';
type Bin<T> = { category: string; items: T[] };

export function binDates<T extends { timestamp: string }>(items: T[]) {
  const list = [...items].sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));

  const bins = new Map<string, Bin<T>>();

  for (const item of list) {
    const category = dateCategory(new Date(item.timestamp));
    let bin = bins.get(category);
    if (!bin) {
      bin = { category, items: [] };
      bins.set(category, bin);
    }
    bin.items.push(item);
  }

  return [...bins.values()];
}

function dateCategory(date: Date) {
  if (isToday(date)) {
    return 'Today';
  }

  if (isYesterday(date)) {
    return 'Yesterday';
  }

  if (isThisWeek(date)) {
    // Include the date so weekday headings cannot be mistaken for project names.
    return format(date, 'EEEE, MMM d');
  }

  const thirtyDaysAgo = subDays(new Date(), 30);

  if (isAfter(date, thirtyDaysAgo)) {
    return 'Past 30 Days';
  }

  if (isThisYear(date)) {
    return format(date, 'MMMM');
  }

  return format(date, 'MMMM yyyy');
}
