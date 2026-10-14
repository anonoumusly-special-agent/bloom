export type AgendaEvent = {
	title: string;
	start: Date;
	end: Date;
	allDay: boolean;
	location?: string;
};

type Property = { value: string; params: string };
type Entry = Map<string, Property[]>;
type ParsedEvent = { uid: string; recurrenceId?: number; start: Date; end: Date; hasEnd: boolean; allDay: boolean; utc: boolean; title: string; location?: string; cancelled: boolean; rule?: string; exclusions: Set<number> };

const property = (entry: Entry, name: string) => entry.get(name)?.[0];
const unescapeText = (value: string) => value.replace(/\\([\\,;nN])/g, (_, char: string) => char.toLowerCase() === "n" ? "\n" : char);

function parseDate(prop?: Property): { date: Date; allDay: boolean; utc: boolean } | null {
	if (!prop) return null;
	const match = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?(Z)?)?$/.exec(prop.value);
	if (!match) return null;
	const [, year, month, day, hour, minute, second, utc] = match;
	if (Number(hour || 0) > 23 || Number(minute || 0) > 59 || Number(second || 0) > 59) return null;
	const allDay = /(?:^|;)VALUE=DATE(?:;|$)/i.test(prop.params) || hour === undefined;
	const parts = [Number(year), Number(month) - 1, Number(day), Number(hour || 0), Number(minute || 0), Number(second || 0)];
	// ponytail: TZID wall times use the computer's local zone; a timezone database is needed for cross-zone accuracy.
	const isUtc = Boolean(utc && !allDay);
	const date = isUtc ? new Date(Date.UTC(...(parts as [number, number, number, number, number, number]))) : new Date(...(parts as [number, number, number, number, number, number]));
	if (Number.isNaN(date.getTime()) ||
		(isUtc ? date.getUTCFullYear() !== Number(year) || date.getUTCMonth() !== Number(month) - 1 || date.getUTCDate() !== Number(day) : date.getFullYear() !== Number(year) || date.getMonth() !== Number(month) - 1 || date.getDate() !== Number(day))) return null;
	return { date, allDay, utc: isUtc };
}

function durationMs(value?: string): number | null {
	if (!value) return null;
	const match = /^([+-])?P(?:(\d+)W|(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?)$/i.exec(value);
	if (!match || !match.slice(2).some(Boolean)) return null;
	const [, sign, weeks, days, hours, minutes, seconds] = match;
	return (sign === "-" ? -1 : 1) * ((Number(weeks || 0) * 7 + Number(days || 0)) * 86400 + Number(hours || 0) * 3600 + Number(minutes || 0) * 60 + Number(seconds || 0)) * 1000;
}

function nthWeekday(year: number, month: number, weekday: number, ordinal: number): number | null {
	const days = new Date(year, month + 1, 0).getDate();
	const matches = Array.from({ length: days }, (_, index) => index + 1).filter(day => new Date(year, month, day).getDay() === weekday);
	return matches[ordinal > 0 ? ordinal - 1 : matches.length + ordinal] ?? null;
}

function ruleDates(event: ParsedEvent, from: Date, to: Date, budget: { remaining: number }): Date[] {
	if (!event.rule) return [event.start];
	const rule = Object.fromEntries(event.rule.split(";").map(part => part.split("=", 2))) as Record<string, string>;
	const frequency = rule.FREQ;
	if (!["DAILY", "WEEKLY", "MONTHLY", "YEARLY"].includes(frequency)) return [event.start];
	const interval = Math.max(1, Number.parseInt(rule.INTERVAL || "1", 10) || 1);
	const count = rule.COUNT ? Math.max(0, Number.parseInt(rule.COUNT, 10) || 0) : Infinity;
	const until = rule.UNTIL ? parseDate({ value: rule.UNTIL, params: "" }) : null;
	const untilTime = until ? until.allDay ? new Date(until.date.getFullYear(), until.date.getMonth(), until.date.getDate() + 1).getTime() - 1 : until.date.getTime() : Infinity;
	const weekdays = ["SU", "MO", "TU", "WE", "TH", "FR", "SA"];
	const byDay = (rule.BYDAY || "").split(",").filter(Boolean).map(token => {
		const match = /^([+-]?\d+)?(SU|MO|TU|WE|TH|FR|SA)$/.exec(token);
		return match ? { ordinal: match[1] ? Number(match[1]) : 0, weekday: weekdays.indexOf(match[2]) } : null;
	}).filter((day): day is { ordinal: number; weekday: number } => day !== null);
	const parts = (date: Date) => event.utc ? [date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), date.getUTCHours(), date.getUTCMinutes(), date.getUTCSeconds(), date.getUTCDay()] : [date.getFullYear(), date.getMonth(), date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds(), date.getDay()];
	const make = (year: number, month: number, day: number, hour: number, minute: number, second: number) => event.utc ? new Date(Date.UTC(year, month, day, hour, minute, second)) : new Date(year, month, day, hour, minute, second);
	const [year, month, day, hour, minute, second, weekday] = parts(event.start);
	const result: Date[] = [];
	let seen = 0;
	// ponytail: 10,000 periods across the feed bound CPU; farther occurrences need a calendar engine.
	for (let step = 0; budget.remaining-- > 0 && seen < count; step++) {
		let candidates: Date[] = [];
		if (frequency === "DAILY") {
			candidates = [make(year, month, day + step * interval, hour, minute, second)];
		} else if (frequency === "WEEKLY") {
			const monday = make(year, month, day - (weekday + 6) % 7 + step * interval * 7, hour, minute, second);
			const [mYear, mMonth, mDay] = parts(monday);
			candidates = (byDay.length ? byDay : [{ weekday, ordinal: 0 }]).map(item => make(mYear, mMonth, mDay + (item.weekday + 6) % 7, hour, minute, second));
		} else {
			const monthStart = make(year, month + step * interval * (frequency === "YEARLY" ? 12 : 1), 1, hour, minute, second);
			const [mYear, mMonth] = parts(monthStart);
			const days = byDay.length && frequency === "MONTHLY" ? byDay.flatMap(day => {
				if (day.ordinal) return [nthWeekday(mYear, mMonth, day.weekday, day.ordinal)].filter((value): value is number => value !== null);
				return Array.from({ length: new Date(mYear, mMonth + 1, 0).getDate() }, (_, index) => index + 1).filter(value => new Date(mYear, mMonth, value).getDay() === day.weekday);
			}) : [day];
			candidates = days.map(value => make(mYear, mMonth, value, hour, minute, second)).filter(date => parts(date)[1] === mMonth);
		}
		candidates.sort((a, b) => a.getTime() - b.getTime());
		if (candidates[0] && candidates[0].getTime() >= to.getTime() && candidates[0].getTime() > untilTime) break;
		if (candidates[0] && candidates[0].getTime() >= to.getTime() && count === Infinity) break;
		for (const candidate of candidates) {
			const time = candidate.getTime();
			if (time < event.start.getTime()) continue;
			if (time > untilTime) return result;
			seen++;
			if (seen > count) return result;
			if (time < to.getTime() && time + (event.end.getTime() - event.start.getTime()) > from.getTime()) result.push(candidate);
		}
	}
	return result;
}

export function parseIcs(text: string, from: Date, to: Date): AgendaEvent[] {
	const entries: Entry[] = [];
	let current: Entry | null = null;
	for (const line of text.replace(/\r\n?/g, "\n").replace(/\n[ \t]/g, "").split("\n")) {
		if (line === "BEGIN:VEVENT") current = new Map();
		else if (line === "END:VEVENT") { if (current) entries.push(current); current = null; }
		else if (current) {
			const colon = line.indexOf(":");
			if (colon < 0) continue;
			const [name, ...params] = line.slice(0, colon).split(";");
			if (!name) continue;
			const values = current.get(name.toUpperCase()) || [];
			values.push({ value: line.slice(colon + 1), params: params.join(";").toUpperCase() });
			current.set(name.toUpperCase(), values);
		}
	}
	const events: ParsedEvent[] = entries.flatMap((entry, index) => {
		const start = parseDate(property(entry, "DTSTART"));
		const recurrence = parseDate(property(entry, "RECURRENCE-ID"));
		if (!start && !recurrence) return [];
		const effectiveStart = start || recurrence!;
		const explicitEnd = parseDate(property(entry, "DTEND"));
		const duration = durationMs(property(entry, "DURATION")?.value);
		const end = explicitEnd?.date || (duration !== null ? new Date(effectiveStart.date.getTime() + duration) : effectiveStart.allDay ? new Date(effectiveStart.date.getFullYear(), effectiveStart.date.getMonth(), effectiveStart.date.getDate() + 1) : new Date(effectiveStart.date.getTime() + 3600000));
		const exclusions = new Set<number>();
		for (const value of entry.get("EXDATE") || []) for (const date of value.value.split(",")) {
			const parsed = parseDate({ ...value, value: date });
			if (parsed) exclusions.add(parsed.date.getTime());
		}
		return [{ uid: property(entry, "UID")?.value || `missing-${index}`, recurrenceId: recurrence?.date.getTime(), start: effectiveStart.date, end, hasEnd: Boolean(explicitEnd || duration !== null), allDay: effectiveStart.allDay, utc: effectiveStart.utc, title: unescapeText(property(entry, "SUMMARY")?.value || "(Ohne Titel)"), location: property(entry, "LOCATION") ? unescapeText(property(entry, "LOCATION")!.value) : undefined, cancelled: property(entry, "STATUS")?.value === "CANCELLED", rule: property(entry, "RRULE")?.value, exclusions }];
	});
	const overrides = new Map(events.filter(event => event.recurrenceId !== undefined).map(event => [`${event.uid}:${event.recurrenceId}`, event]));
	const usedOverrides = new Set<string>();
	const result: AgendaEvent[] = [];
	const budget = { remaining: 10000 };
	const add = (event: ParsedEvent, start = event.start, end = event.end) => {
		if (!event.cancelled && start < to && end > from) result.push({ title: event.title, start, end, allDay: event.allDay, ...(event.location ? { location: event.location } : {}) });
	};
	const occurrenceEnd = (event: ParsedEvent, start: Date) => {
		const days = event.allDay ? Math.round((Date.UTC(event.end.getFullYear(), event.end.getMonth(), event.end.getDate()) - Date.UTC(event.start.getFullYear(), event.start.getMonth(), event.start.getDate())) / 86400000) : 0;
		return days ? new Date(start.getFullYear(), start.getMonth(), start.getDate() + days) : new Date(start.getTime() + event.end.getTime() - event.start.getTime());
	};
	for (const event of events) {
		if (event.recurrenceId !== undefined || event.cancelled) continue;
		for (const start of ruleDates(event, from, to, budget)) {
			const key = `${event.uid}:${start.getTime()}`;
			const override = overrides.get(key);
			if (override) { usedOverrides.add(key); add(override, override.start, override.hasEnd ? override.end : occurrenceEnd(event, override.start)); }
			else if (!event.exclusions.has(start.getTime())) {
				add(event, start, occurrenceEnd(event, start));
			}
		}
	}
	for (const [key, override] of overrides) if (!usedOverrides.has(key)) add(override);
	return result.sort((a, b) => a.start.getTime() - b.start.getTime());
}
