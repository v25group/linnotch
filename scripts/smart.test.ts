// Self-check for src/features/clipboard/smart.ts. Run: node scripts/smart.test.ts
import assert from "node:assert/strict";
import { smart } from "../src/features/clipboard/smart.ts";

const now = Date.UTC(2026, 9, 24, 12);
const b64url = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");

const jwt = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ sub: "ana", exp: now / 1000 + 7200 })}.sig`;
assert.equal(smart(jwt, now)?.label, "JWT · HS256");
assert.equal(smart(jwt, now)?.note, "expires in 2 h · for ana");
assert.deepEqual(JSON.parse(smart(jwt, now)!.copy[0].text), { sub: "ana", exp: now / 1000 + 7200 });

assert.equal(smart('{"a":1,"b":[1,2]}')?.label, "JSON · 2 keys");
assert.deepEqual(smart('{"a":1}')?.copy.map((c) => c.label), ["Pretty"], "already minified");
assert.equal(smart("[1, 2"), null, "broken JSON is just text");

assert.equal(smart("1761307200", now)?.copy[0].text, "2025-10-24T12:00:00.000Z");
assert.equal(smart("2026-10-24T12:00:00Z", now)?.copy[0].text, String(now / 1000));
assert.equal(smart("12345"), null, "short numbers aren't timestamps");

assert.equal(smart("#ff8000")?.copy[0].text, "rgb(255, 128, 0)");
assert.equal(smart("#f80")?.copy[0].text, "rgb(255, 136, 0)");
assert.equal(smart("rgb(255, 128, 0)")?.copy[0].text, "#ff8000");

assert.equal(smart("123e4567-e89b-12d3-a456-426614174000")?.copy[0].text, "123e4567e89b12d3a456426614174000");
assert.equal(smart("name%3DAna%20Lee")?.copy[0].text, "name=Ana Lee");
assert.equal(smart(Buffer.from("hello from linnotch").toString("base64"))?.copy[0].text, "hello from linnotch");
assert.equal(smart("JustSomeWords"), null, "plain words aren't Base64");
assert.equal(smart("hello world"), null);

console.log("smart.ts: all checks passed");
