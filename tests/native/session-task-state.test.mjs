import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  partitionCollapsed,
  reviewEvidenceVerified,
  taskBucketFor,
  taskStateFor,
  taskStateHintKey,
  taskStateLabelKey,
} from '../../src/features/sessions/sessionTaskState.ts';

const running = { running: true };
const ended = { running: false, exitCode: 0 };

test('a bell or an adapter interface needs a person, and its wording stays honest', () => {
  const bell = { ...running, bell: true };
  assert.equal(taskStateFor(bell), 'needsYou');
  // A bell supports "look at this", never a named request.
  assert.equal(taskStateLabelKey('needsYou', bell), 'sessions.bellBadge');

  for (const kind of ['approval', 'question']) {
    const evidence = { ...running, attention: kind };
    assert.equal(taskStateFor(evidence), 'needsYou');
    assert.equal(taskStateLabelKey('needsYou', evidence), kind === 'approval' ? 'sessions.taskNeedsApproval' : 'sessions.taskNeedsAnswer');
  }
  // A named request wins over the bell that announced it.
  assert.equal(taskStateLabelKey('needsYou', { ...running, bell: true, attention: 'approval' }), 'sessions.taskNeedsApproval');
});

test('an idle prompt is not a finished round, a delivery or a review', () => {
  const idle = { ...running, resting: true, outputActive: false };
  assert.equal(taskStateFor(idle), 'unknown');
  assert.equal(taskStateLabelKey('unknown', idle), 'sessions.stateIdle');
  assert.equal(taskBucketFor('unknown'), 'unknown');
  // No evidence at all still refuses to claim a result.
  assert.equal(taskStateFor(running), 'unknown');
  assert.equal(taskStateLabelKey('unknown', running), 'sessions.stateIdle');
});

test('output activity is working, and a quiet running session stays unknown', () => {
  assert.equal(taskStateFor({ ...running, outputActive: true }), 'working');
  assert.equal(taskStateLabelKey('working', { ...running, outputActive: true }), 'sessions.stateStreaming');
  // Nothing describes a running session that is neither waiting nor producing output.
  assert.equal(taskStateFor({ ...running, outputActive: false }), 'unknown');
  assert.equal(taskStateHintKey('unknown', { ...running }), null);
});

test('exit codes are process facts: a clean exit is ended, a failed one is error', () => {
  assert.equal(taskStateFor(ended), 'ended');
  assert.equal(taskStateLabelKey('ended', ended), 'sessions.taskEnded');
  assert.equal(taskStateFor({ running: false, exitCode: 2 }), 'error');
  assert.equal(taskStateLabelKey('error', { running: false, exitCode: 2 }), 'sessions.stateError');
  // An exit without a code is still an exit; it is never a failure by assumption.
  assert.equal(taskStateFor({ running: false, exitCode: null }), 'ended');
  assert.equal(taskBucketFor('error'), 'ended');
  assert.equal(taskBucketFor('error', { unread: true }), 'attention');
});

test('a remote transport that may still run is unknown, not ended and not failed', () => {
  const remote = { running: false, exitCode: 1, remoteUnconfirmed: true };
  assert.equal(taskStateFor(remote), 'unknown');
  assert.equal(taskStateLabelKey('unknown', remote), 'sessions.activityUnknown');
  assert.equal(taskStateHintKey('unknown', remote), 'sessions.sshUnknownShort');
});

test('a user mark or a verified result is the only automatic review claim', () => {
  assert.equal(taskStateFor({ ...ended, marked: true }), 'readyReview');
  assert.equal(taskStateFor({ ...ended, verified: true }), 'readyReview');
  assert.equal(taskStateLabelKey('readyReview', { ...ended, verified: true }), 'sessions.taskReadyReview');
  assert.equal(taskStateHintKey('readyReview', { ...ended, verified: true }), 'sessions.taskReviewVerified');
  assert.equal(taskStateHintKey('readyReview', { ...ended, marked: true }), 'sessions.taskReviewMarked');
  // A mark applies to a quiet round, but resumed output invalidates it without clearing it.
  assert.equal(taskStateFor({ ...running, marked: true }), 'readyReview');
  assert.equal(taskStateFor({ ...running, marked: true, outputActive: true }), 'working');
  // A prompt waiting for a person outranks the mark.
  assert.equal(taskStateFor({ ...running, marked: true, attention: 'approval' }), 'needsYou');
});

test('review evidence counts only when the returned key was re-read', () => {
  assert.equal(reviewEvidenceVerified('review-1|returned|1', 'review-1|returned|1'), true);
  assert.equal(reviewEvidenceVerified('review-1|returned|1', 'review-1|returned|0'), false);
  assert.equal(reviewEvidenceVerified('review-1|returned|1', undefined), false);
  assert.equal(reviewEvidenceVerified(null, null), false);
});

test('collapsing moves a row out of the active list without changing its state', () => {
  const rows = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const { active, collapsed } = partitionCollapsed(rows, (row) => row.id, new Set(['b']));
  assert.deepEqual(active.map((row) => row.id), ['a', 'c']);
  assert.deepEqual(collapsed.map((row) => row.id), ['b']);
  // An id that is not present in the list never appears in either side.
  assert.deepEqual(partitionCollapsed(rows, (row) => row.id, new Set(['zzz'])).collapsed, []);
});
