// Pure check, no stack needed. A round whose close was refused published
// nothing: the real browsers report it as not published, never as a latency
// measured against the previous round's version.
import test from 'node:test';
import assert from 'node:assert/strict';
import { browserRounds } from '../rehearse/evaluate.mjs';

test('a refused close is not_published, a missing receipt is never', () => {
  const closes = [
    { round: 1, start: 1000, ok: true, final_version: 1 },
    { round: 2, start: 5000, ok: true, final_version: 2 },
    { round: 3, start: 9000, ok: false, final_version: 2 },
  ];
  const browsers = [
    { role: 'display', path: 'direct', receipts: [{ t: 1200, version: 1 }, { t: 5300, version: 2 }], status: [{}] },
    { role: 'participant', path: 'venue', receipts: [{ t: 1400, version: 1 }], status: [{}, {}] },
  ];
  const [display, participant] = browserRounds(browsers, closes);
  assert.deepEqual(display.rounds.map((r) => r.ms), [200, 300, 'not_published']);
  assert.deepEqual(participant.rounds.map((r) => r.ms), [400, 'never', 'not_published']);
  assert.equal(participant.status_changes, 2);
});
