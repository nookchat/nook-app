package app.nook;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.ContentValues;
import android.content.Context;
import android.content.Intent;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.PorterDuff;
import android.graphics.PorterDuffXfermode;
import android.net.Uri;
import android.os.Build;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.Window;
import android.widget.Toast;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.FileProvider;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsControllerCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * What the phone adds to the page, as the desktop shell's preload does: whether you look at the app,
 * system notifications and their clicks, voice that keeps going with the app put away, saving a file
 * to Downloads, and nook:// and home site links opened in the app.
 */
@CapacitorPlugin(
    name = "NookPhone",
    permissions = { @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS }) }
)
public class NookPhonePlugin extends Plugin {

    static final String CHANNEL_MESSAGES = "messages";
    private static final String EXTRA_NOTE = "app.nook.note";
    /** The voice notification has id 1; message notifications count up from here. */
    private static final int FIRST_NOTE = 1000;
    private static final int LARGEST_PICTURE_BYTES = 8 * 1024 * 1024;

    /** The home site, and the old one, whose invite links open in the app. */
    private static final Set<String> HOSTS = new HashSet<>(
        Arrays.asList("nookchat.app", "www.nookchat.app", "cathode.video", "www.cathode.video")
    );

    private static NookPhonePlugin live;

    private boolean looking = true;
    private int counted = FIRST_NOTE;

    @Override
    public void load() {
        live = this;
        channels(getContext());
    }

    @Override
    protected void handleOnResume() {
        setLooking(true);
    }

    @Override
    protected void handleOnPause() {
        setLooking(false);
    }

    @Override
    protected void handleOnDestroy() {
        if (live == this) live = null;
        // The page that was in voice is gone with the window.
        VoiceService.stop(getContext());
    }

    @Override
    protected void handleOnNewIntent(Intent intent) {
        if (intent == null) return;
        String note = intent.getStringExtra(EXTRA_NOTE);
        if (note != null) {
            intent.removeExtra(EXTRA_NOTE);
            JSObject data = new JSObject();
            data.put("id", note);
            notifyListeners("notifyClick", data);
            return;
        }
        if (Intent.ACTION_VIEW.equals(intent.getAction()) && intent.getData() != null) {
            String link = appLink(intent.getData());
            intent.setData(null);
            if (link != null) getBridge().getWebView().loadUrl(link);
        }
    }

    /**
     * The page shown when the site cannot be reached is local, at the shell's own host, which
     * Capacitor would hand to the browser: it stays in the app. Its Try again asks for /retry, and
     * the home site loads again.
     */
    @Override
    public Boolean shouldOverrideLoad(Uri url) {
        String offline = getBridge().getErrorUrl();
        if (offline == null || url == null || url.getHost() == null) return null;
        if (!url.getHost().equalsIgnoreCase(Uri.parse(offline).getHost())) return null;
        if ("/retry".equals(url.getPath())) {
            getBridge().getWebView().loadUrl(getBridge().getAppUrl());
            return true;
        }
        return false;
    }

    /** A nook:// link, or a link to the home site, as the same link on the home site the app loads. */
    private String appLink(Uri uri) {
        String home = getBridge().getServerUrl();
        if (home == null) return null;
        String scheme = uri.getScheme() == null ? "" : uri.getScheme().toLowerCase();
        String host = uri.getHost() == null ? "" : uri.getHost().toLowerCase();
        boolean ours = scheme.equals("nook") || (scheme.equals("https") && HOSTS.contains(host));
        if (!ours) return null;
        String fragment = uri.getEncodedFragment();
        String base = home.endsWith("/") ? home : home + "/";
        return fragment == null || fragment.isEmpty() ? base : base + "#" + fragment;
    }

    private void setLooking(boolean now) {
        if (looking == now) return;
        looking = now;
        JSObject data = new JSObject();
        data.put("looking", now);
        notifyListeners("looking", data);
    }

    /** Whether you look at the app now, and whether it may notify: granted, denied or prompt. */
    @PluginMethod
    public void state(PluginCall call) {
        JSObject out = new JSObject();
        out.put("looking", looking);
        out.put("notify", notifyState());
        call.resolve(out);
    }

    private String notifyState() {
        if (Build.VERSION.SDK_INT >= 33) {
            PermissionState state = getPermissionState("notifications");
            if (state == PermissionState.DENIED) return "denied";
            if (state != PermissionState.GRANTED) return "prompt";
        }
        return NotificationManagerCompat.from(getContext()).areNotificationsEnabled() ? "granted" : "denied";
    }

    @PluginMethod
    public void askNotify(PluginCall call) {
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) {
            requestPermissionForAlias("notifications", call, "notifyAsked");
            return;
        }
        notifyAsked(call);
    }

    @PermissionCallback
    private void notifyAsked(PluginCall call) {
        JSObject out = new JSObject();
        out.put("notify", notifyState());
        call.resolve(out);
    }

    static void channels(Context context) {
        if (Build.VERSION.SDK_INT < 26) return;
        NotificationManager manager = context.getSystemService(NotificationManager.class);
        NotificationChannel messages = new NotificationChannel(CHANNEL_MESSAGES, "Messages and calls", NotificationManager.IMPORTANCE_HIGH);
        messages.setDescription("Mentions, direct messages and calls.");
        manager.createNotificationChannel(messages);
        NotificationChannel voice = new NotificationChannel(VoiceService.CHANNEL, "In voice", NotificationManager.IMPORTANCE_LOW);
        voice.setDescription("Shows while you are in a voice channel or a call.");
        voice.setShowBadge(false);
        manager.createNotificationChannel(voice);
    }

    /**
     * A system notification. `picture` is the sender's face and `image` a picture from the message,
     * both as data URLs. A tap opens the app and says `notifyClick` with `id`.
     */
    @PluginMethod
    public void show(PluginCall call) {
        Context context = getContext();
        String id = call.getString("id", "");
        String title = call.getString("title", "Nook");
        String body = call.getString("body", "");
        int number = ++counted;

        Intent open = new Intent(context, MainActivity.class)
            .setAction("app.nook.NOTE." + number)
            .addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP)
            .putExtra(EXTRA_NOTE, id);
        PendingIntent tap = PendingIntent.getActivity(
            context,
            number,
            open,
            PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT
        );

        NotificationCompat.Builder note = new NotificationCompat.Builder(context, CHANNEL_MESSAGES)
            .setSmallIcon(R.drawable.ic_stat_nook)
            .setColor(0xFFFF8A5B)
            .setContentTitle(title)
            .setContentText(body)
            .setStyle(new NotificationCompat.BigTextStyle().bigText(body))
            .setCategory(NotificationCompat.CATEGORY_MESSAGE)
            .setPriority(NotificationCompat.PRIORITY_HIGH)
            .setAutoCancel(true)
            .setContentIntent(tap);
        Bitmap face = round(picture(call.getString("picture", "")));
        if (face != null) note.setLargeIcon(face);
        Bitmap image = picture(call.getString("image", ""));
        if (image != null) note.setStyle(new NotificationCompat.BigPictureStyle().bigPicture(image).setSummaryText(body));

        try {
            NotificationManagerCompat.from(context).notify(number, note.build());
            call.resolve();
        } catch (SecurityException ex) {
            call.reject("Notifications are not allowed.");
        }
    }

    /** A PNG or JPEG data URL as a picture, or null. */
    private static Bitmap picture(String url) {
        if (url == null || !url.startsWith("data:image/")) return null;
        int comma = url.indexOf(',');
        if (comma < 0 || url.length() - comma > LARGEST_PICTURE_BYTES) return null;
        try {
            byte[] bytes = Base64.decode(url.substring(comma + 1), Base64.DEFAULT);
            return BitmapFactory.decodeByteArray(bytes, 0, bytes.length);
        } catch (IllegalArgumentException ex) {
            return null;
        }
    }

    /** A face is a circle, as it is in the page. */
    private static Bitmap round(Bitmap square) {
        if (square == null) return null;
        int side = Math.min(square.getWidth(), square.getHeight());
        Bitmap out = Bitmap.createBitmap(side, side, Bitmap.Config.ARGB_8888);
        Canvas canvas = new Canvas(out);
        Paint paint = new Paint(Paint.ANTI_ALIAS_FLAG);
        canvas.drawCircle(side / 2f, side / 2f, side / 2f, paint);
        paint.setXfermode(new PorterDuffXfermode(PorterDuff.Mode.SRC_IN));
        canvas.drawBitmap(square, (side - square.getWidth()) / 2f, (side - square.getHeight()) / 2f, paint);
        return out;
    }

    /**
     * The colour of the page, `#rrggbb`, behind the status bar and the navigation bar, with dark
     * icons on a light colour and light icons on a dark one.
     */
    @PluginMethod
    public void bars(PluginCall call) {
        String hex = call.getString("color", "");
        if (hex == null || !hex.matches("#[0-9a-fA-F]{6}")) {
            call.reject("A colour is #rrggbb.");
            return;
        }
        int color = Color.parseColor(hex);
        boolean light = (0.2126 * Color.red(color) + 0.7152 * Color.green(color) + 0.0722 * Color.blue(color)) / 255 > 0.5;
        getBridge()
            .executeOnMainThread(() -> {
                Window window = getActivity().getWindow();
                WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(window, window.getDecorView());
                bars.setAppearanceLightStatusBars(light);
                bars.setAppearanceLightNavigationBars(light);
                window.getDecorView().setBackgroundColor(color);
                getBridge().getWebView().setBackgroundColor(color);
                call.resolve();
            });
    }

    /**
     * In voice: `on` with the words for the notification that keeps the call going while the app
     * is put away. Off when you leave.
     */
    @PluginMethod
    public void voice(PluginCall call) {
        if (!call.getBoolean("on", false)) {
            VoiceService.stop(getContext());
            call.resolve();
            return;
        }
        try {
            VoiceService.show(
                getContext(),
                call.getString("title", "In voice"),
                call.getString("text", ""),
                call.getBoolean("muted", false)
            );
            call.resolve();
        } catch (RuntimeException ex) {
            call.reject("The call cannot keep going in the background: " + ex.getMessage());
        }
    }

    /** A button on the voice notification: mute or leave. */
    static void voiceAction(String action) {
        NookPhonePlugin plugin = live;
        if (plugin == null) return;
        JSObject data = new JSObject();
        data.put("action", action);
        plugin.notifyListeners("voiceAction", data);
    }

    /** A file the page is saving, a part at a time. */
    private static final class Saving {

        final String name;
        final String type;
        final Uri uri;
        final File file;
        final OutputStream out;

        Saving(String name, String type, Uri uri, File file, OutputStream out) {
            this.name = name;
            this.type = type;
            this.uri = uri;
            this.file = file;
            this.out = out;
        }
    }

    private final Map<String, Saving> saving = new HashMap<>();
    private int saved = 0;

    /**
     * Starts saving a file from the page to Downloads. Android 9 and older keep it apart and share it
     * at the end instead. Returns the `id` that saveChunk and saveEnd take.
     */
    @PluginMethod
    public void saveStart(PluginCall call) {
        String name = safeName(call.getString("name", "file"));
        String type = call.getString("type", "application/octet-stream");
        Context context = getContext();
        try {
            Saving next;
            if (Build.VERSION.SDK_INT >= 29) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.DISPLAY_NAME, name);
                values.put(MediaStore.Downloads.MIME_TYPE, type);
                values.put(MediaStore.Downloads.RELATIVE_PATH, Environment.DIRECTORY_DOWNLOADS);
                values.put(MediaStore.Downloads.IS_PENDING, 1);
                Uri uri = context.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, values);
                OutputStream out = uri == null ? null : context.getContentResolver().openOutputStream(uri);
                if (out == null) throw new IllegalStateException("Downloads refused the file.");
                next = new Saving(name, type, uri, null, out);
            } else {
                File dir = new File(context.getCacheDir(), "shared");
                if (!dir.isDirectory() && !dir.mkdirs()) throw new IllegalStateException("No room for the file.");
                File file = new File(dir, name);
                next = new Saving(name, type, null, file, new FileOutputStream(file));
            }
            String id = String.valueOf(++saved);
            saving.put(id, next);
            JSObject out = new JSObject();
            out.put("id", id);
            call.resolve(out);
        } catch (Exception ex) {
            call.reject("The file could not be saved: " + ex.getMessage());
        }
    }

    /** The next part of the file, as base64. */
    @PluginMethod
    public void saveChunk(PluginCall call) {
        Saving file = saving.get(call.getString("id", ""));
        if (file == null) {
            call.reject("No file is being saved.");
            return;
        }
        try {
            file.out.write(Base64.decode(call.getString("data", ""), Base64.DEFAULT));
            call.resolve();
        } catch (Exception ex) {
            drop(call.getString("id", ""));
            call.reject("The file could not be saved: " + ex.getMessage());
        }
    }

    /** The file is whole: it shows in Downloads, or the share sheet opens. `cancel` throws it away. */
    @PluginMethod
    public void saveEnd(PluginCall call) {
        String id = call.getString("id", "");
        if (call.getBoolean("cancel", false)) {
            drop(id);
            call.resolve();
            return;
        }
        Saving file = saving.remove(id);
        if (file == null) {
            call.reject("No file is being saved.");
            return;
        }
        Context context = getContext();
        try {
            file.out.close();
            if (file.uri != null) {
                ContentValues values = new ContentValues();
                values.put(MediaStore.Downloads.IS_PENDING, 0);
                context.getContentResolver().update(file.uri, values, null, null);
                getActivity().runOnUiThread(() -> Toast.makeText(context, "Saved to Downloads", Toast.LENGTH_SHORT).show());
            } else {
                Uri uri = FileProvider.getUriForFile(context, context.getPackageName() + ".fileprovider", file.file);
                Intent send = new Intent(Intent.ACTION_SEND)
                    .setType(file.type)
                    .putExtra(Intent.EXTRA_STREAM, uri)
                    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                getActivity().startActivity(Intent.createChooser(send, file.name));
            }
            call.resolve();
        } catch (Exception ex) {
            call.reject("The file could not be saved: " + ex.getMessage());
        }
    }

    private void drop(String id) {
        Saving file = saving.remove(id);
        if (file == null) return;
        try {
            file.out.close();
        } catch (Exception ex) {
            // Already closed.
        }
        if (file.uri != null) getContext().getContentResolver().delete(file.uri, null, null);
        if (file.file != null && !file.file.delete()) file.file.deleteOnExit();
    }

    private static String safeName(String name) {
        String clean = name.replaceAll("[\\\\/:*?\"<>|\\p{Cntrl}]", "_").trim();
        if (clean.isEmpty() || clean.equals(".") || clean.equals("..")) return "file";
        return clean.length() > 120 ? clean.substring(clean.length() - 120) : clean;
    }
}
