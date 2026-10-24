import runtime from '../../server/netlify-runtime.cjs';
import reminders from '../../server/reminder-runner.cjs';
export default async () => {
  // Keep the whole invocation below the scheduled-function execution limit,
  // including every database/Discord request, rather than timing each alone.
  const deadline = AbortSignal.timeout(26000);
  const request = (url, options = {}) => fetch(url, { ...options, signal: options.signal ? AbortSignal.any([deadline, options.signal]) : deadline });
  const app = runtime.createWebRuntime({ request });
  const result = await reminders.runReminders(app);
  // Do not log IDs, inventory, messages or credentials.
  console.log('[reprice-reminders]', JSON.stringify(result));
  return new Response(null, { status: 204 });
};
export const config = { schedule: '*/10 * * * *' };
