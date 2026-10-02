package app.nook;

import android.os.Bundle;
import android.webkit.WebView;
import androidx.activity.OnBackPressedCallback;
import androidx.core.content.ContextCompat;
import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        registerPlugin(NookPhonePlugin.class);
        super.onCreate(savedInstanceState);
        if (getBridge() == null) return;
        WebView page = getBridge().getWebView();
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
