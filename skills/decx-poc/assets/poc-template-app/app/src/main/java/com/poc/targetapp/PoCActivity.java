package com.poc.targetapp;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Bundle;
import android.util.Log;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.TextView;

public class PoCActivity extends Activity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_poc);

        LinearLayout container = findViewById(R.id.container);

        TextView header = new TextView(this);
        header.setText(buildHeaderText());
        container.addView(header);

        for (ExploitEntry entry : ExploitRegistry.EXPLOITS) {
            Button btn = new Button(this);
            btn.setText(entry.title);
            btn.setOnClickListener(v -> {
                Log.i("PoC", "Executing: " + entry.id);
                try {
                    entry.action.run();
                } catch (Exception e) {
                    Log.e("PoC", "Failed: " + entry.id, e);
                }
            });
            container.addView(btn);
        }

        runRequestedExploit(getIntent());
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        runRequestedExploit(intent);
    }

    private String buildHeaderText() {
        return getPackageName()
                + "\n"
                + "poc-targetapp://run/trigger?exploit=<id>"
                + "\n"
                + "Edit server/public/index.html for links"
                + "\n"
                + "Edit server/public/scenario.js for JS bridge logic"
                + "\n";
    }

    private void runRequestedExploit(Intent intent) {
        String exploitId = parseExploitId(intent);
        if (exploitId == null || exploitId.isEmpty()) {
            return;
        }

        ExploitEntry entry = ExploitRegistry.findById(exploitId);
        if (entry == null) {
            Log.w("PoC", "Unknown exploit id from route: " + exploitId);
            return;
        }

        Log.i("PoC", "Executing from route: " + entry.id);
        try {
            entry.action.run();
        } catch (Exception e) {
            Log.e("PoC", "Failed from route: " + entry.id, e);
        }
    }

    private String parseExploitId(Intent intent) {
        if (intent == null) {
            return null;
        }
        String fromExtra = intent.getStringExtra("exploit");
        if (fromExtra != null && !fromExtra.isEmpty()) {
            return fromExtra;
        }
        Uri data = intent.getData();
        if (data == null) {
            return null;
        }
        return data.getQueryParameter("exploit");
    }
}
