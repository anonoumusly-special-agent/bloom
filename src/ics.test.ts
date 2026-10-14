import { parseIcs } from "./ics.ts";

const assert = {
	equal(actual: unknown, expected: unknown) {
		if (actual !== expected) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	},
	deepEqual(actual: unknown, expected: unknown) {
		if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
};

const from = new Date(2026, 0, 1);
const to = new Date(2026, 1, 1);
const calendar = (events: string) => `BEGIN:VCALENDAR\n${events}\nEND:VCALENDAR`;
const event = (lines: string) => `BEGIN:VEVENT\n${lines}\nEND:VEVENT`;
const parse = (events: string) => parseIcs(calendar(events), from, to);

let result = parse(event("UID:one\nDTSTART:20260105T090000\nDTEND:20260105T100000\nSUMMARY:Meet\\, plan\\; now\\nNext\nLOCATION:Office"));
assert.equal(result.length, 1);
assert.equal(result[0].title, "Meet, plan; now\nNext");
assert.equal(result[0].location, "Office");
assert.equal(result[0].end.getHours(), 10);

result = parse(event("UID:all\nDTSTART;VALUE=DATE:20260106\nDTEND;VALUE=DATE:20260107\nSUMMARY:Holiday"));
assert.equal(result[0].allDay, true);
assert.equal(result[0].end.getDate(), 7);

result = parse(event("UID:weekly\nDTSTART:20260105T090000\nDURATION:PT30M\nRRULE:FREQ=WEEKLY;BYDAY=MO,WE;COUNT=4\nSUMMARY:Standup"));
assert.deepEqual(result.map(item => item.start.getDate()), [5, 7, 12, 14]);
assert.equal(result[0].end.getMinutes(), 30);

result = parse(event("UID:until\nDTSTART:20260105T090000Z\nRRULE:FREQ=DAILY;UNTIL=20260107T090000Z\nEXDATE:20260106T090000Z\nSUMMARY:Daily"));
assert.deepEqual(result.map(item => item.start.getUTCDate()), [5, 7]);

const master = event("UID:series\nDTSTART:20260105T090000\nDTEND:20260105T110000\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:Original");
const override = event("UID:series\nRECURRENCE-ID:20260106T090000\nDTSTART:20260106T110000\nSUMMARY:Moved");
const cancelled = event("UID:series\nRECURRENCE-ID:20260107T090000\nSTATUS:CANCELLED");
result = parse(`${master}\n${override}\n${cancelled}`);
assert.deepEqual(result.map(item => item.title), ["Original", "Moved"]);
assert.equal(result[1].start.getHours(), 11);
assert.equal(result[1].end.getHours(), 13);

result = parse(event("UID:folded\nDTSTART:20260105T090000\nSUMMARY:Very long\n title"));
assert.equal(result[0].title, "Very longtitle");

result = parse(event("UID:monthly\nDTSTART:20260101T090000\nRRULE:FREQ=MONTHLY;BYDAY=1MO,-1FR;COUNT=2\nSUMMARY:Review"));
assert.deepEqual(result.map(item => item.start.getDate()), [5, 30]);

result = parseIcs(calendar(event("UID:utc\nDTSTART:20260307T090000Z\nRRULE:FREQ=DAILY;COUNT=4\nSUMMARY:UTC")), new Date(2026, 2, 7), new Date(2026, 2, 12));
assert.deepEqual(result.map(item => item.start.getUTCHours()), [9, 9, 9, 9]);

result = parseIcs(calendar(event("UID:dst\nDTSTART;VALUE=DATE:20260307\nRRULE:FREQ=DAILY;COUNT=3\nSUMMARY:Day")), new Date(2026, 2, 7), new Date(2026, 2, 11));
assert.deepEqual(result.map(item => item.end.getDate()), [8, 9, 10]);
assert.deepEqual(result.map(item => item.end.getHours()), [0, 0, 0]);

console.log("ok");
