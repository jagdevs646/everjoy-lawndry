package com.everjoy.lawndry;

import android.os.Bundle;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(Bundle savedInstanceState) {
        registerPlugin(PrivacyScreenPlugin.class);   // no screenshots of slip / ID QR codes
        super.onCreate(savedInstanceState);
    }
}
