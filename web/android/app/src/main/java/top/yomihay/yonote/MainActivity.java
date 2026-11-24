package top.yomihay.yonote;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;
import android.os.Bundle;
import android.webkit.WebView;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(InputMotionPlugin.class);
        super.onCreate(savedInstanceState);
        bridge.addWebViewListener(new WebViewListener() {
            private boolean inspected = false;

            @Override
            public void onPageCommitVisible(WebView view, String url) {
                // APK assets are already offline. Retire the v0.1 PWA shell cache on upgrade,
                // keeping IndexedDB notes, attachments and login state untouched.
                if (inspected) return;
                inspected = true;
                view.evaluateJavascript("""
                    (() => {
                      if (!('serviceWorker' in navigator)) return;
                      navigator.serviceWorker.getRegistrations().then(async registrations => {
                        if (!registrations.length) return;
                        await Promise.all(registrations.map(r => r.unregister()));
                        if ('caches' in window) {
                          const names = await caches.keys();
                          await Promise.all(names.filter(n => n.startsWith('workbox-')).map(n => caches.delete(n)));
                        }
                        location.reload();
                      }).catch(error => console.warn('Shell cache upgrade', error));
                    })();
                    """, null);
            }
        });
    }
}
