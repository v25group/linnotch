// Self-check for src/features/timer/timeparse.ts. Run: node scripts/timeparse.test.ts
import assert from "node:assert/strict";
import { parseAlarm, parseDuration } from "../src/features/timer/timeparse.ts";

const s = 1000, m = 60 * s, h = 60 * m;
assert.equal(parseDuration("7"), 7 * m);
assert.equal(parseDuration("2.5"), 2.5 * m);
assert.equal(parseDuration("1:30"), m + 30 * s);
assert.equal(parseDuration("1:05:00"), h + 5 * m);
assert.equal(parseDuration("90s"), 90 * s);
assert.equal(parseDuration("1h20"), h + 20 * m);
assert.equal(parseDuration("1h 20m"), h + 20 * m);
assert.equal(parseDuration("45 min"), 45 * m);
assert.equal(parseDuration("2h"), 2 * h);
for (const bad of ["", "abc", "0", "-5", "25h", "1:2:3:4"]) assert.equal(parseDuration(bad), null, bad);

// 24 Oct 2026, 10:00 local time.
const now = new Date(2026, 9, 24, 10, 0).getTime();
const at = (d: number, hh: number, mm: number) => new Date(2026, 9, d, hh, mm).getTime();
assert.equal(parseAlarm("10:30", now), at(24, 10, 30));
assert.equal(parseAlarm("7:30", now), at(24, 19, 30), "7:30 am has passed, so this evening");
assert.equal(parseAlarm("9:34", at(24, 21, 30)), at(24, 21, 34), "said at 9:30 pm: tonight, not tomorrow morning");
assert.equal(parseAlarm("12:15", now), at(24, 12, 15));
assert.equal(parseAlarm("7:30am", now), at(25, 7, 30), "am given, already past: tomorrow");
assert.equal(parseAlarm("0730", now), at(25, 7, 30), "leading zero: 24-hour clock");
assert.equal(parseAlarm("7:30pm", now), at(24, 19, 30));
assert.equal(parseAlarm("7pm", now), at(24, 19, 0));
assert.equal(parseAlarm("12am", now), at(25, 0, 0));
assert.equal(parseAlarm("19:05", now), at(24, 19, 5));
assert.equal(parseAlarm("1930", now), at(24, 19, 30));
for (const bad of ["25:00", "7:75", "13pm", "noon", ""]) assert.equal(parseAlarm(bad, now), null, bad);

console.log("timeparse.ts: all checks passed");
