import { useEffect, useState } from 'react';
import { z } from 'zod';
import { errorFeedback, FeedbackLine, noteFeedback, type Feedback } from './Feedback';
import { getJson, messageOf, postJson } from './organization-requests.client';

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
          setFeedback(
            errorFeedback(messageOf(failure instanceof Error ? failure : null, 'Unable to load this setting.')),
          );
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
            : 'Your next model requests won’t be logged. Logs already recorded stay in the account.',
        ),
      );
    } catch (failure) {
      setFeedback(errorFeedback(messageOf(failure instanceof Error ? failure : null, 'Unable to save. Try again.')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <section
      id="ai-request-logs"
      className="app-card w-full min-w-0 p-4 [overflow-wrap:anywhere]"
      aria-labelledby="ai-request-logs-heading"
    >
      <h2 id="ai-request-logs-heading" className="app-card-title">
        AI request logs
      </h2>
      <p className="mt-2 max-w-2xl text-sm text-content-secondary">
        While this is on, your model requests are logged in the AI Gateway of the Cloudflare account you build in: your
        prompts, the conversation context and project files sent with them, and the model’s replies. Anyone with access
        to that account can read these logs, which in a team’s account includes its admins. CloudChef’s operator gets no
        copy.
      </p>
      <label className="mt-3 flex min-w-0 items-center gap-2 text-sm text-content-primary">
        <input
          type="checkbox"
          checked={contentLogging === true}
          disabled={contentLogging === null || saving}
          onChange={(event) => void choose(event.target.checked)}
        />
        Log my model requests in AI Gateway
      </label>
      <p className="mt-2 max-w-2xl text-sm text-content-secondary">
        Turning this off stops logging your requests from then on, in every account you build in. They still go through
        AI Gateway, unlogged. Logs already recorded stay until the account’s AI Gateway retention removes them, or
        someone with access deletes them in the Cloudflare dashboard.
      </p>
      <FeedbackLine feedback={feedback} />
    </section>
  );
}
