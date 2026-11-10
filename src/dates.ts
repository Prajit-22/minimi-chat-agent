/**
 * Deterministic relative-date resolution.
 *
 * Models are bad at date arithmetic ("last Tuesday", "on 3 November").
 * Instead of trusting the model, we resolve the common relative-date
 * phrases in the user's message against the local clock and hand the
 * model explicit absolute dates as context hints.
 */

export interface DateHint {
  /** The phrase as it appeared in the message, e.g. "last Tuesday". */
  phrase: string;
  /** Resolved local calendar day, YYYY-MM-DD. */
  iso: string;
  /** Weekday name of the resolved day, e.g. "Tuesday". */
  weekday: string;
}

const WEEKDAY_NAMES = [
  'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday',
];

const MONTH_NAMES = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

const WORD_NUMBERS: Record<string, number> = {
  a: 1, an: 1, one: 1, two: 2, three: 3, four: 4, five: 5,
  six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
};

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function addDays(d: Date, n: number): Date {
  const out = startOfDay(d);
  out.setDate(out.getDate() + n);
  return out;
}

export function toISODate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

function weekdayName(d: Date): string {
  return WEEKDAY_NAMES[d.getDay()]!;
}

/** Most recent `weekday` (0=Sunday) on or before `from`. */
function recentWeekday(from: Date, weekday: number, includeToday: boolean): Date {
  const base = startOfDay(from);
  let delta = (base.getDay() - weekday + 7) % 7;
  if (!includeToday && delta === 0) delta = 7;
  return addDays(base, -delta);
}

export function resolveDateHints(text: string, now: Date = new Date()): DateHint[] {
  // Regexes run with the ignore-case flag so captured phrases keep their
  // original casing for display; matching is still case-insensitive.
  const lower = text;
  const hints: DateHint[] = [];
  const seen = new Set<string>();

  const add = (phrase: string, d: Date) => {
    const iso = toISODate(d);
    const key = `${phrase}|${iso}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({ phrase: phrase.trim(), iso, weekday: weekdayName(d) });
  };

  if (/\btoday\b/i.test(lower)) add('today', now);
  if (/\byesterday\b/i.test(lower)) add('yesterday', addDays(now, -1));
  if (/\btomorrow\b/i.test(lower)) add('tomorrow', addDays(now, 1));

  // "3 days ago", "two weeks ago", "a month ago"
  const agoRe = /(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+(day|week|month)s?\s+ago/gi;
  for (const m of lower.matchAll(agoRe)) {
    const n = WORD_NUMBERS[m[1]!.toLowerCase()] ?? parseInt(m[1]!, 10);
    if (Number.isNaN(n)) continue;
    const unit = m[2]!.toLowerCase();
    let d: Date;
    if (unit === 'day') d = addDays(now, -n);
    else if (unit === 'week') d = addDays(now, -7 * n);
    else {
      d = startOfDay(now);
      d.setMonth(d.getMonth() - n);
    }
    add(m[0], d);
  }

  // "last Tuesday", "this Monday", "on Friday", bare "Friday"
  const weekdayRe = new RegExp(
    `\\b(last|this|on)\\s+(?:the\\s+)?(${WEEKDAY_NAMES.map((w) => w.toLowerCase()).join('|')})\\b` +
    `|\\b(${WEEKDAY_NAMES.map((w) => w.toLowerCase()).join('|')})\\b`,
    'gi',
  );
  for (const m of lower.matchAll(weekdayRe)) {
    const modifier = m[1]?.toLowerCase();
    const name = (m[2] ?? m[3])!.toLowerCase();
    const weekday = WEEKDAY_NAMES.findIndex((w) => w.toLowerCase() === name);
    if (weekday < 0) continue;
    if (modifier === 'last') add(m[0], recentWeekday(now, weekday, false));
    else if (modifier === 'this') {
      // This week's occurrence (week starts Monday), may be today or later.
      const monday = addDays(now, -((now.getDay() + 6) % 7));
      add(m[0], addDays(monday, (weekday + 6) % 7));
    } else add(m[0], recentWeekday(now, weekday, true));
  }

  // "3 November", "November 3", "on 3 November 2026"
  const monthAlternation = MONTH_NAMES.join('|');
  const dMonthRe = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?(${monthAlternation})(?:,)?(?:\\s+(\\d{4}))?\\b`, 'gi');
  const monthDRe = new RegExp(`\\b(${monthAlternation})\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,)?(?:\\s+(\\d{4}))?\\b`, 'gi');
  const handleMonthDate = (dayStr: string, monthName: string, yearStr: string | undefined, phrase: string) => {
    const day = parseInt(dayStr, 10);
    const month = MONTH_NAMES.indexOf(monthName.toLowerCase());
    if (month < 0 || day < 1 || day > 31) return;
    let year = yearStr ? parseInt(yearStr, 10) : now.getFullYear();
    let d = new Date(year, month, day);
    if (d.getMonth() !== month) return; // e.g. February 31 rolls over
    // Without an explicit year, mean the most recent occurrence.
    if (!yearStr && startOfDay(d) > startOfDay(now)) {
      d = new Date(year - 1, month, day);
    }
    add(phrase, d);
  };
  for (const m of lower.matchAll(dMonthRe)) handleMonthDate(m[1]!, m[2]!, m[3], m[0]);
  for (const m of lower.matchAll(monthDRe)) handleMonthDate(m[2]!, m[1]!, m[3], m[0]);

  return hints;
}

/** Format hints as an extra context block for the model. */
export function formatDateHints(hints: DateHint[]): string {
  if (hints.length === 0) return '';
  const lines = hints.map((h) => `- "${h.phrase}" = ${h.weekday}, ${h.iso}`);
  return `Dates in the user's message, already resolved for you (do not re-derive them):\n${lines.join('\n')}`;
}
