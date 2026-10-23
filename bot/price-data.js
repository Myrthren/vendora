'use strict';

// Shared, public-only price evidence. Daily roll-ups are not unique listings.
const DAY = 86400000;
const median = values => {
  const s = values.filter(Number.isFinite).sort((a, b) => a - b);
  return s.length ? (s[Math.floor((s.length - 1) / 2)] + s[Math.ceil((s.length - 1) / 2)]) / 2 : null;
};
const round = n => Math.round(n * 100) / 100;
const slug = s => String(s).normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function readDays(list, now = Date.now()) {
  return (Array.isArray(list) ? list : []).flatMap(entry => {
    const date = Date.parse(entry.day);
    if (!Number.isFinite(date) || date > now || date < now - 90 * DAY) return [];
    const samples = Array.isArray(entry.samples) ? entry.samples : [entry];
    const valid = samples.filter(s => Number.isFinite(s.median) && s.median > 0 &&
      Number.isFinite(s.p25) && s.p25 > 0 && Number.isFinite(s.p75) &&
      s.p25 <= s.median && s.median <= s.p75 && Number.isFinite(s.n) && s.n >= 8);
    if (!valid.length) return [];
    return [{ day: entry.day, median: round(median(valid.map(s => s.median))),
      p25: round(median(valid.map(s => s.p25))), p75: round(median(valid.map(s => s.p75))),
      observations: valid.reduce((n, s) => n + s.n, 0) }];
  }).sort((a, b) => a.day.localeCompare(b.day));
}

function marketEvidence(daily, now = Date.now()) {
  return Object.entries(daily || {}).flatMap(([keyword, list]) => {
    if (!keyword.trim() || keyword.length > 100) return [];
    const days = readDays(list, now);
    const latest = days.at(-1);
    if (!latest) return [];
    const recent = days.filter(d => Date.parse(d.day) >= now - 30 * DAY);
    const week = days.filter(d => Date.parse(d.day) >= Date.parse(latest.day) - 6 * DAY);
    const previous = days.filter(d => Date.parse(d.day) < Date.parse(latest.day) - 6 * DAY &&
      Date.parse(d.day) >= Date.parse(latest.day) - 13 * DAY);
    const weekMedian = median(week.map(d => d.median));
    const previousMedian = previous.length >= 4 ? median(previous.map(d => d.median)) : null;
    return [{ keyword, slug: slug(keyword), ...latest, days: recent, weekDays: week.length,
      weekMedian: round(weekMedian), weekStart: week[0].day,
      weekChange: week.length >= 4 && previousMedian ? round((weekMedian / previousMedian - 1) * 100) : null,
      fresh: now - Date.parse(latest.day) <= 3 * DAY,
      mixed: latest.p75 / latest.p25 > 2.5 }];
  });
}

module.exports = { DAY, median, round, slug, readDays, marketEvidence };
