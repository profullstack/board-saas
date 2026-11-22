// The voice trial length A/B test: 90 days (control) against 30 days, reported to
// CrawlProof through @profullstack/abtest (stats at crawlproof.com/dashboard/experiments).
//
// An account gets its arm at its first voice meeting, sticky, and keeps that trial
// length. Anyone outside the experiment (accounts whose trial started before it, or
// every account when BOARD_VOICE_TRIAL_EXPERIMENT=off) gets the 90-day control.
//
// Events, all with idempotency ids so a retry never double counts:
//   exposure      the trial started (the conversion denominator)
//   event         voice_meeting, once per voice meeting held during the trial (engagement)
//   conversion    a voice pass was paid for
//   revenue       the amount paid, in USD
//
// CrawlProof being down never blocks a meeting: assign() falls back to the same
// deterministic arm locally, and tracking calls only log a failure.
import { createClient } from '@profullstack/abtest';

export const VOICE_TRIAL_EXPERIMENT = 'board-saas.voice-trial-length';
export const VOICE_TRIAL_CONTROL_DAYS = 90;
export const VOICE_TRIAL_ARMS = [
  { key: '90d', label: '90-day free trial', days: 90 },
  { key: '30d', label: '30-day free trial', days: 30 },
];
const daysOf = (arm) => VOICE_TRIAL_ARMS.find((a) => a.key === arm)?.days ?? null;

export function createVoiceTrialExperiment({ env = process.env, log = console.log, client: clientOverride } = {}) {
  const key = env.BOARD_VOICE_TRIAL_EXPERIMENT || VOICE_TRIAL_EXPERIMENT;
  const enabled = key !== 'off';
  const client =
    clientOverride ??
    createClient({ token: env.CRAWLPROOF_TOKEN || undefined, baseUrl: env.CRAWLPROOF_URL || undefined, timeoutMs: Number(env.CRAWLPROOF_TIMEOUT_MS) || 3000 });
  const arms = VOICE_TRIAL_ARMS.map(({ key: k, label }) => ({ key: k, label }));
  let ensured = null;

  /** Create the experiment on CrawlProof once per process (a no-op when it exists). */
  function ensure() {
    if (!enabled) return Promise.resolve();
    ensured ??= client
      .experiment({
        key,
        name: 'board.saas voice trial length',
        description: 'Voice meetings free trial: 90 days (control) vs 30 days. Unit = account, assigned at its first voice meeting. Conversion = paid voice pass; revenue = its USD amount; voice_meeting = voice meetings held during the trial.',
        arms,
        control: '90d',
        min_per_arm: 100,
      })
      .then((r) => {
        if (!r.ok) {
          log(`abtest: could not create ${key} on CrawlProof (${r.error}); arms still assigned locally`);
          ensured = null;
        }
      });
    return ensured;
  }

  const report = (what, p) =>
    p.then((r) => {
      if (!r.ok) log(`abtest: ${what} not recorded (${r.error})`);
      return r;
    });

  return {
    key,
    enabled,
    ensure,
    /** { arm, days } for an account starting its trial now. Control (90 days, arm null) when the test is off. */
    async assign(accountId) {
      if (!enabled) return { arm: null, days: VOICE_TRIAL_CONTROL_DAYS, offline: false };
      await ensure();
      const r = await client.assign(key, accountId, arms);
      const days = daysOf(r.arm);
      if (!days) return { arm: null, days: VOICE_TRIAL_CONTROL_DAYS, offline: true };
      if (r.offline) log(`abtest: assigned ${accountId} to ${r.arm} locally (${r.error})`);
      return { arm: r.arm, days, offline: !!r.offline };
    },
    exposure: (accountId, arm) => report('exposure', client.exposure(key, accountId, { arm, id: `trial-start:${accountId}` })),
    meeting: (accountId, arm, meetingId) => report('voice_meeting', client.event(key, accountId, 'voice_meeting', { arm, id: `voice-meeting:${meetingId}` })),
    async purchase(accountId, arm, paymentId, amountUsd) {
      const c = await report('conversion', client.conversion(key, accountId, { arm, id: `voice-pass:${paymentId}` }));
      const amount = Number(amountUsd);
      const r = Number.isFinite(amount) && amount > 0 ? await report('revenue', client.revenue(key, accountId, amount, { arm, id: `voice-pass-revenue:${paymentId}` })) : null;
      return { conversion: c, revenue: r };
    },
  };
}
