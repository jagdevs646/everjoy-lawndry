package com.everjoy.lawndry;

import static org.junit.Assert.*;

import android.os.SystemClock;
import android.util.Log;
import android.view.ViewGroup;
import android.webkit.WebView;
import androidx.test.core.app.ActivityScenario;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import java.util.concurrent.ArrayBlockingQueue;
import java.util.concurrent.TimeUnit;
import org.json.JSONArray;
import org.junit.Test;
import org.junit.runner.RunWith;

@RunWith(AndroidJUnit4.class)
public class PasswordLayoutTest {
    private String evaluate(ActivityScenario<MainActivity> activity, String script) throws Exception {
        ArrayBlockingQueue<String> result = new ArrayBlockingQueue<>(1);
        activity.onActivity(a -> a.getBridge().getWebView().evaluateJavascript(script, result::offer));
        String value = result.poll(10, TimeUnit.SECONDS);
        assertNotNull("No response from WebView", value);
        return value;
    }

    @Test
    public void registrationPasswordFieldsMatchAtEveryWidth() throws Exception {
        try (ActivityScenario<MainActivity> activity = ActivityScenario.launch(MainActivity.class)) {
            long deadline = SystemClock.elapsedRealtime() + 60000;
            while (!evaluate(activity, "Boolean(document.querySelector('a[href=\"#/register\"]'))").equals("true")) {
                assertTrue("Sign-in screen did not appear", SystemClock.elapsedRealtime() < deadline);
                SystemClock.sleep(150);
            }
            evaluate(activity, "document.querySelector('a[href=\"#/register\"]').click()");
            for (int width : new int[] {360, 390, 768, 1280}) {
                double density = Double.parseDouble(evaluate(activity, "devicePixelRatio"));
                activity.onActivity(a -> {
                    WebView web = a.getBridge().getWebView();
                    ViewGroup.LayoutParams params = web.getLayoutParams();
                    params.width = (int)Math.round(width * density);
                    web.setLayoutParams(params);
                });
                deadline = SystemClock.elapsedRealtime() + 10000;
                while (!evaluate(activity, "innerWidth === " + width + " && document.querySelectorAll('input[type=password]').length === 2").equals("true")) {
                    assertTrue("Unable to measure at " + width, SystemClock.elapsedRealtime() < deadline);
                    SystemClock.sleep(100);
                }
                for (String theme : new String[] {"public", "student", "staff", "admin"}) {
                    evaluate(activity, "document.documentElement.dataset.theme='" + theme + "'");
                    JSONArray pair = new JSONArray(evaluate(activity,
                        "Array.from(document.querySelectorAll('input[type=password]'), e => {" +
                        "const r=e.getBoundingClientRect(), s=getComputedStyle(e);return [r.width,r.height,s.font,s.border]})"));
                    JSONArray first = pair.getJSONArray(0), second = pair.getJSONArray(1);
                    assertEquals(first.getDouble(0), second.getDouble(0), 0.1);
                    assertEquals(first.getDouble(1), second.getDouble(1), 0.01);
                    assertEquals(first.getString(2), second.getString(2));
                    assertEquals(first.getString(3), second.getString(3));
                    Log.i("EverjoyLayout", "width=" + width + " theme=" + theme + " heights=" +
                        first.getDouble(1) + "," + second.getDouble(1));
                }
            }
        }
    }
}
