package app.nook;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;
import androidx.core.splashscreen.SplashScreen;
import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

public class MainActivity extends BridgeActivity {

    /** However the page's start goes, the splash is gone by then. */
    private static final long SPLASH_MOST_MS = 15_000;

    /** The page has drawn its loading screen. Until then the splash stays, not an empty window. */
    private volatile boolean pageShown = false;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // The ghost stays on its tile while the page comes from the network, which takes a few
        // seconds on a cold start. The page's own loading screen takes over once it is drawn.
        SplashScreen.installSplashScreen(this).setKeepOnScreenCondition(() -> !pageShown);
        bridgeBuilder.addWebViewListener(
            new WebViewListener() {
                @Override
                public void onPageCommitVisible(WebView view, String url) {
                    pageShown = true;
                }

                @Override
                public void onReceivedError(WebView view) {
                    pageShown = true;
                }
            }
        );
        registerPlugin(NookPhonePlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() == null) {
            pageShown = true;
            return;
        }
        WebView page = getBridge().getWebView();
        page.postDelayed(() -> pageShown = true, SPLASH_MOST_MS);
        // The colour behind the page until it paints: cream by day, charcoal after dark.
        page.setBackgroundColor(ContextCompat.getColor(this, R.color.nook_surface));
        // Back closes what the page opened, a picture or a side bar, through its history. With nothing
        // left, the app goes behind the others, as Discord's does, so a call and the messages keep coming.
        getOnBackPressedDispatcher()
            .addCallback(
                this,
                new OnBackPressedCallback(true) {
                    @Override
                    public void handleOnBackPressed() {
                        if (page.canGoBack()) page.goBack();
                        else moveTaskToBack(true);
                    }
                }
            );
    }
}
