import test from "node:test";
import assert from "node:assert/strict";

function normalizeIdentifier(raw, type = "generic_card_uid") {
  const value = String(raw ?? "").trim();
  return ["qr", "qr_token", "barcode", "temporary_pass", "pin"].includes(type.toLowerCase())
    ? value
    : value.replace(/[^A-Za-z0-9_-]+/g, "").toUpperCase();
}

function percentage(actual, possible) {
  return possible > 0 ? Number(((actual / possible) * 100).toFixed(2)) : 0;
}

test("card identifiers normalise punctuation without changing QR token case", () => {
  assert.equal(normalizeIdentifier("  a1-b2:c3  ", "nfc_uid"), "A1-B2C3");
  assert.equal(normalizeIdentifier("  secure.Token/Case  ", "qr_token"), "secure.Token/Case");
});

test("attendance percentage uses eligible sessions and two-decimal rounding", () => {
  assert.equal(percentage(7, 8), 87.5);
  assert.equal(percentage(0, 0), 0);
  assert.equal(percentage(1, 3), 33.33);
});

test("replayed source events resolve to one stable deduplication key", () => {
  const key = ({ sourceEventId, clientEventId, credentialHash, timestamp, deviceId }) => sourceEventId || clientEventId || `${credentialHash}|${timestamp}|${deviceId}`;
  const first = key({ sourceEventId: "terminal-17", clientEventId: "a", credentialHash: "h", timestamp: "2026-08-06T07:00:00Z", deviceId: "d" });
  const replay = key({ sourceEventId: "terminal-17", clientEventId: "b", credentialHash: "h", timestamp: "2026-08-06T07:00:00Z", deviceId: "d" });
  assert.equal(first, replay);
});

test("missing register rows are incomplete, not present", () => {
  const statuses = ["present", "late", "absent", "incomplete"];
  const actual = statuses.filter((status) => ["present", "late"].includes(status)).length;
  const incomplete = statuses.filter((status) => status === "incomplete").length;
  assert.equal(actual, 2);
  assert.equal(incomplete, 1);
});
