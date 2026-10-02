package app.nook;

import android.app.Notification;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.net.wifi.WifiManager;
import android.os.Build;
import android.os.IBinder;
import android.os.PowerManager;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.app.ServiceCompat;
import androidx.core.content.ContextCompat;

/**
 * Keeps a call going while the app is put away or the screen is off, as Discord does: Android
 * stops the microphone and freezes an app in the background unless a foreground service with a
 * notification runs. The notification says where you talk, with Mute and Leave.
 */
public class VoiceService extends Service {

    static final String CHANNEL = "voice";
    private static final int NOTE_ID = 1;
    private static final String SHOW = "app.nook.voice.SHOW";
    private static final String MUTE = "app.nook.voice.MUTE";
    private static final String LEAVE = "app.nook.voice.LEAVE";

    private static boolean running;
    /** False after a leave, so a start still on its way stops as soon as it lands. */
    private static boolean wanted;

    private PowerManager.WakeLock wake;
    private WifiManager.WifiLock wifi;

    /** Starts the service, or changes the words of its notification when it runs. Call it while the app is in front. */
    static void show(Context context, String title, String text, boolean muted) {
        wanted = true;
        if (running) {
            try {
                NotificationManagerCompat.from(context).notify(NOTE_ID, note(context, title, text, muted));
            } catch (SecurityException ex) {
                // No leave to show notifications: the service runs without one in view.
            }
            return;
        }
        Intent start = new Intent(context, VoiceService.class)
            .setAction(SHOW)
            .putExtra("title", title)
            .putExtra("text", text)
            .putExtra("muted", muted);
        ContextCompat.startForegroundService(context, start);
    }

    static void stop(Context context) {
        wanted = false;
        if (!running) return;
        context.stopService(new Intent(context, VoiceService.class));
    }

    private static Notification note(Context context, String title, String text, boolean muted) {
        PendingIntent open = PendingIntent.getActivity(
            context,
            0,
            new Intent(context, MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );
        return new NotificationCompat.Builder(context, CHANNEL)
            .setSmallIcon(R.drawable.ic_stat_nook)
            .setColor(0xFFFF8A5B)
            .setContentTitle(title)
            .setContentText(muted ? (text.isEmpty() ? "Muted" : text + " · Muted") : text)
            .setCategory(NotificationCompat.CATEGORY_CALL)
            .setOngoing(true)
            .setSilent(true)
            .setShowWhen(false)
            .setForegroundServiceBehavior(NotificationCompat.FOREGROUND_SERVICE_IMMEDIATE)
            .setContentIntent(open)
            .addAction(0, muted ? "Unmute" : "Mute", action(context, MUTE, 1))
            .addAction(0, "Leave", action(context, LEAVE, 2))
            .build();
    }

    private static PendingIntent action(Context context, String what, int code) {
        Intent intent = new Intent(context, VoiceService.class).setAction(what);
        return PendingIntent.getService(context, code, intent, PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT);
    }

    @Override
    public int onStartCommand(Intent intent, int flags, int startId) {
        String what = intent == null ? null : intent.getAction();
        if (MUTE.equals(what) || LEAVE.equals(what)) {
            NookPhonePlugin.voiceAction(MUTE.equals(what) ? "mute" : "leave");
            // A button on a notification left over from a call that is gone.
            if (!running) stopSelf();
            return START_NOT_STICKY;
        }
        if (!SHOW.equals(what)) {
            stopSelf();
            return START_NOT_STICKY;
        }
        String title = intent.getStringExtra("title");
        String text = intent.getStringExtra("text");
        Notification note = note(this, title == null ? "In voice" : title, text == null ? "" : text, intent.getBooleanExtra("muted", false));
        int type = Build.VERSION.SDK_INT >= 30 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE : 0;
        try {
            ServiceCompat.startForeground(this, NOTE_ID, note, type);
        } catch (RuntimeException ex) {
            // Android refuses a microphone service without the microphone permission, or from the background.
            stopSelf();
            return START_NOT_STICKY;
        }
        running = true;
        // Android needs startForeground from a service started this way, even one left before it landed.
        if (!wanted) {
            stopSelf();
            return START_NOT_STICKY;
        }
        hold();
        return START_NOT_STICKY;
    }

    /** The processor and the Wi-Fi stay awake with the screen off, so the sound does not break up. */
    private void hold() {
        if (wake == null) {
            PowerManager power = getSystemService(PowerManager.class);
            wake = power.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nook:voice");
            wake.setReferenceCounted(false);
            wake.acquire();
        }
        if (wifi == null) {
            WifiManager manager = (WifiManager) getApplicationContext().getSystemService(Context.WIFI_SERVICE);
            if (manager != null) {
                int mode = Build.VERSION.SDK_INT >= 29 ? WifiManager.WIFI_MODE_FULL_LOW_LATENCY : WifiManager.WIFI_MODE_FULL_HIGH_PERF;
                wifi = manager.createWifiLock(mode, "nook:voice");
                wifi.setReferenceCounted(false);
                wifi.acquire();
            }
        }
    }

    @Override
    public void onTaskRemoved(Intent rootIntent) {
        // The app was swiped away: the page, and the call with it, are gone.
        stopSelf();
    }

    @Override
    public void onDestroy() {
        running = false;
        if (wake != null && wake.isHeld()) wake.release();
        if (wifi != null && wifi.isHeld()) wifi.release();
        wake = null;
        wifi = null;
        ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
        super.onDestroy();
    }

    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }
}
