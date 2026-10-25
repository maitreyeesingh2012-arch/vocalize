// Daily practice reminders.
//
// In the native apps this uses Capacitor's Local Notifications plugin
// (@capacitor/local-notifications), which fires even when the app is closed.
// A plain web page can't reliably notify when closed, so on the web the time is
// saved to the profile and takes effect once the singer installs the app.

const REMINDER_ID = 7101;

function plugin() {
  return window.Capacitor?.Plugins?.LocalNotifications || null;
}

export function reminderSupport() {
  if (plugin()) return { native: true, note: 'We’ll send a gentle nudge at this time every day.' };
  return { native: false, note: 'Choose a daily time. Reminders are delivered by the Vocalize phone app.' };
}

/** Schedule (time "HH:MM") or cancel (null) the daily reminder. Returns true if scheduled on-device. */
export async function scheduleReminder(time) {
  const ln = plugin();
  if (!ln) return false;
  try {
    await ln.cancel({ notifications: [{ id: REMINDER_ID }] });
    if (!time) return true;
    const perm = await ln.requestPermissions();
    if (perm.display !== 'granted') return false;
    const [hour, minute] = time.split(':').map(Number);
    await ln.schedule({
      notifications: [{
        id: REMINDER_ID,
        title: 'Time to sing 🎶',
        body: 'Your practice plan is waiting. Even ten minutes keeps your streak alive.',
        schedule: { on: { hour, minute }, repeats: true, allowWhileIdle: true },
      }],
    });
    return true;
  } catch (err) {
    console.warn('Reminder scheduling failed', err);
    return false;
  }
}
