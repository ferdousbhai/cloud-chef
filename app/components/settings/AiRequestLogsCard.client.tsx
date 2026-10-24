import { useEffect, useState } from 'react';
import { z } from 'zod';
import { errorFeedback, FeedbackLine, noteFeedback, type Feedback } from './Feedback';
import { SettingsCard } from './SettingsLayout';
import { getJson, messageOf, postJson } from '~/lib/json-request';

const preferenceSchema = z.object({ contentLogging: z.boolean() });

const PREFERENCE_PATH = '/api/settings/ai-gateway-logging';

/**
 * The person's own choice whether their model requests are logged with their content in the AI
 * Gateway of the Cloudflare account they build in. It applies wherever they build, a team's account
 * included, and only they can change it.
 */
export function AiRequestLogsCard() {
  const [contentLogging, setContentLogging] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>(null);

  useEffect(() => {
    let canceled = false;
    getJson(PREFERENCE_PATH, preferenceSchema)
      .then((preference) => {
        if (!canceled) {
          setContentLogging(preference.contentLogging);
        }
      })
      .catch((failure) => {
        if (!canceled) {
          setFeedback(errorFeedback(messageOf(failure, 'Unable to load this setting.')));
        }
      });
    return () => {
      canceled = true;
    };
  }, []);

  const choose = async (next: boolean) => {
    setSaving(true);
    setFeedback(null);
    try {
      const saved = await postJson(`${PREFERENCE_PATH}/update`, { contentLogging: next }, preferenceSchema);
      setContentLogging(saved.contentLogging);
      setFeedback(
        noteFeedback(
          saved.contentLogging
            ? 'Your next model requests will be logged.'
            : 'Your next model requests won’t be logged, in any account you build in. Logs already recorded stay in the account.',
        ),
      );
    } catch (failure) {
      setFeedback(errorFeedback(messageOf(failure, 'Unable to save. Try again.')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <SettingsCard
      id="ai-request-logs"
      title="AI request logs"
      description="Your prompts, the files sent with them, and the replies, logged in the AI Gateway of the account you build in."
    >
      <label className="mt-3 flex min-w-0 items-center gap-2 rounded-md border border-bolt-elements-borderColor px-3 py-2.5 text-sm text-content-primary">
        <input
          type="checkbox"
          checked={contentLogging === true}
          disabled={contentLogging === null || saving}
          onChange={(event) => void choose(event.target.checked)}
        />
        Log my model requests in AI Gateway
      </label>
      <p className="mt-2 text-xs text-content-tertiary">
        Anyone with access to that account can read them, a team&apos;s admins included. CloudChef&apos;s operator gets
        no copy.
      </p>
      <FeedbackLine feedback={feedback} />
    </SettingsCard>
  );
}
