package top.yomihay.yonote;

import android.content.Context;
import android.view.View;
import android.view.inputmethod.InputMethodManager;
import androidx.annotation.NonNull;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsAnimationCompat;
import androidx.core.view.WindowInsetsCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import java.util.List;

@CapacitorPlugin(name = "InputMotion")
public class InputMotionPlugin extends Plugin {
    private View decor;
    private View.OnLayoutChangeListener layoutListener;

    @Override
    public void load() {
        getActivity().runOnUiThread(() -> {
            decor = getActivity().getWindow().getDecorView();
            // SystemBars owns the insets listener; this observes animation without replacing it.
            ViewCompat.setWindowInsetsAnimationCallback(decor,
                new WindowInsetsAnimationCompat.Callback(
                    WindowInsetsAnimationCompat.Callback.DISPATCH_MODE_CONTINUE_ON_SUBTREE) {
                    @NonNull
                    @Override
                    public WindowInsetsCompat onProgress(@NonNull WindowInsetsCompat insets,
                            @NonNull List<WindowInsetsAnimationCompat> running) {
                        publish(insets, true);
                        return insets;
                    }

                    @Override
                    public void onEnd(@NonNull WindowInsetsAnimationCompat animation) {
                        publish(ViewCompat.getRootWindowInsets(decor), false);
                    }
                });
            layoutListener = (v, l, t, r, b, ol, ot, oright, ob) ->
                publish(ViewCompat.getRootWindowInsets(decor), false);
            getBridge().getWebView().addOnLayoutChangeListener(layoutListener);
        });
    }

    private void publish(WindowInsetsCompat insets, boolean animating) {
        if (insets == null || decor == null) return;
        float density = getActivity().getResources().getDisplayMetrics().density;
        int keyboard = insets.getInsets(WindowInsetsCompat.Type.ime()).bottom;
        int bars = insets.getInsets(WindowInsetsCompat.Type.systemBars()).bottom;
        int[] location = new int[2];
        getBridge().getWebView().getLocationInWindow(location);
        JSObject geometry = new JSObject();
        geometry.put("height", keyboard / density);
        geometry.put("visible", insets.isVisible(WindowInsetsCompat.Type.ime()));
        geometry.put("availableHeight", (decor.getHeight() - Math.max(keyboard, bars) - location[1]) / density);
        geometry.put("animating", animating);
        notifyListeners("geometry", geometry);
    }

    @PluginMethod
    public void hide(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            View web = getBridge().getWebView();
            if (Boolean.TRUE.equals(call.getBoolean("onlyIfVisible"))) {
                WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(web);
                if (insets == null || !insets.isVisible(WindowInsetsCompat.Type.ime())) {
                    call.resolve(new JSObject().put("handled", false));
                    return;
                }
            }
            InputMethodManager input = (InputMethodManager) getActivity().getSystemService(Context.INPUT_METHOD_SERVICE);
            input.hideSoftInputFromWindow(web.getWindowToken(), 0);
            call.resolve(new JSObject().put("handled", true));
        });
    }

    @PluginMethod
    public void show(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            View web = getBridge().getWebView();
            web.requestFocus();
            InputMethodManager input = (InputMethodManager) getActivity().getSystemService(Context.INPUT_METHOD_SERVICE);
            input.showSoftInput(web, InputMethodManager.SHOW_IMPLICIT);
            call.resolve();
        });
    }

    @Override
    protected void handleOnDestroy() {
        getActivity().runOnUiThread(() -> {
            if (decor != null) ViewCompat.setWindowInsetsAnimationCallback(decor, null);
            if (layoutListener != null) getBridge().getWebView().removeOnLayoutChangeListener(layoutListener);
        });
    }
}
