/** Background reviews are opt-in on this browser; manual GPT stays available. */
export const FOLLOWUP_REVIEW_SETTING = 'gptFollowupAutoReviewEnabled';
export const FOLLOWUP_ALARM = 'sgc-gpt-followup-review';

export async function isFollowupReviewEnabled(): Promise<boolean> {
  const saved = await chrome.storage.local.get(FOLLOWUP_REVIEW_SETTING);
  return saved[FOLLOWUP_REVIEW_SETTING] === true;
}

export async function ensureFollowupAlarm(): Promise<void> {
  if (!await isFollowupReviewEnabled()) {
    await chrome.alarms.clear(FOLLOWUP_ALARM);
    return;
  }
  const alarm = await chrome.alarms.get(FOLLOWUP_ALARM);
  if (!alarm || alarm.periodInMinutes !== 1) {
    await chrome.alarms.create(FOLLOWUP_ALARM, { delayInMinutes: 1, periodInMinutes: 1 });
  }
}

export function installFollowupSchedule(review: () => Promise<void>): void {
  const report = (error: unknown) => console.warn('[GPT follow-up schedule]', error);
  const sync = () => { void ensureFollowupAlarm().catch(report); };
  const wake = () => {
    void isFollowupReviewEnabled().then(enabled => enabled ? review() : undefined).catch(report);
  };
  chrome.runtime.onStartup.addListener(() => { sync(); wake(); });
  chrome.runtime.onInstalled.addListener(sync);
  chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === FOLLOWUP_ALARM) wake(); });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && FOLLOWUP_REVIEW_SETTING in changes) sync();
  });
  sync();
}
