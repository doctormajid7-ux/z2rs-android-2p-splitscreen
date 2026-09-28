package org.z2rs.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.ActivityInfo;
import android.database.Cursor;
import android.net.Uri;
import android.provider.DocumentsContract;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.webkit.ConsoleMessage;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileNotFoundException;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;

/**
 * z2rs on Android: the web frontend inside a WebView.
 *
 * <p>The site ships in the APK's assets and is served from
 * {@code https://appassets.androidplatform.net/} by intercepting requests, not
 * from {@code file://} — a file origin cannot instantiate wasm, and https also
 * keeps IndexedDB (save states) and the audio worklet working.
 *
 * <p>The one piece of policy this class owns beyond that is orientation: the
 * portrait two-player split turns the picture into two halves stacked up the
 * screen, so while it is on the activity stays in portrait (the page reports
 * the flag through {@code z2.ext.split.on()}, polled the way the rest of the
 * frontends expect). Everything else — the split itself, the doubled canvas,
 * the second touch pad — is the page's own.
 */
public class MainActivity extends Activity {
    private static final String TAG = "z2rs";

    /** Origin the site is served from (see the class comment). */
    private static final String HOST = "appassets.androidplatform.net";
    /** Asset directory holding the site; page URLs map straight onto it. */
    private static final String ASSETS = "site/";
    /** A picked ROM is kept here so the next launch finds it. */
    private static final String ROM_NAME = "zelda2.nes";

    private static final int REQ_PICK_ROM = 1;
    private static final int REQ_PICK_HD = 2;
    /** Where a picked HD pack folder is mounted for the page to read. */
    private static final String HD_ROOT = "/_hdp/";
    /** How often to ask the page whether the split is on (ms). */
    private static final long ORIENT_EVERY_MS = 250;
    /** Refuse to keep a "ROM" bigger than this. */
    private static final long MAX_ROM_BYTES = 4L * 1024 * 1024;

    private WebView webView;
    private final Handler ui = new Handler(Looper.getMainLooper());
    private ValueCallback<Uri[]> fileCallback;
    /** App-private storage; resolved once, used from the request thread too. */
    private File storageDir;
    /** Whether *this* activity has asked for portrait because of the split. */
    private boolean splitPortrait;
    /**
     * The folder the player picked for an HD pack, while this session lasts.
     * A WebView cannot hand the page a directory, so the page asks for one
     * with {@code z2rs://hd-pack} and reads the tree back under /_hdp/.
     */
    private Uri hdTree;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle state) {
        super.onCreate(state);

        File external = getExternalFilesDir(null);
        storageDir = external != null ? external : getFilesDir();

        webView = new WebView(this);
        webView.setBackgroundColor(0xFF000000);

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        // Snapshots and SRAM live in IndexedDB; localStorage is the fallback.
        settings.setDomStorageEnabled(true);
        // The page unlocks audio on the first touch, so do not make that
        // touch also start the media clock.
        settings.setMediaPlaybackRequiresUserGesture(false);
        // Everything the page reads comes through shouldInterceptRequest.
        settings.setAllowFileAccess(false);
        settings.setUseWideViewPort(true);
        settings.setLoadWithOverviewMode(true);
        settings.setSupportZoom(false);
        settings.setBuiltInZoomControls(false);
        settings.setDisplayZoomControls(false);
        WebView.setWebContentsDebuggingEnabled(true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serve(request.getUrl());
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if (HOST.equals(uri.getHost())) {
                    return false;
                }
                // Only the shell can pick a *folder*: the page's own
                // `<input webkitdirectory>` gets bare file names from the
                // WebView chooser, which never match a pack's `sheets/…`.
                if ("z2rs".equals(uri.getScheme())) {
                    if ("hd-pack".equals(uri.getHost())) {
                        pickHdPack();
                    }
                    return true;
                }
                // A link out of the app (release page, Discord) belongs to the
                // browser, not to the WebView showing the game.
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException e) {
                    Log.i(TAG, "no browser for " + uri);
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            /** The page's "Choose ROM file…" buttons land here. */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (fileCallback != null) {
                    fileCallback.onReceiveValue(null);
                }
                fileCallback = callback;
                Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT);
                pick.addCategory(Intent.CATEGORY_OPENABLE);
                pick.setType("*/*");
                try {
                    startActivityForResult(pick, REQ_PICK_ROM);
                } catch (ActivityNotFoundException e) {
                    Log.w(TAG, "no document picker");
                    fileCallback.onReceiveValue(null);
                    fileCallback = null;
                }
                return true;
            }

            @Override
            public boolean onConsoleMessage(ConsoleMessage message) {
                Log.d(TAG, message.message() + " (" + message.sourceId() + ':' + message.lineNumber() + ')');
                return true;
            }
        });

        setContentView(webView);
        webView.loadUrl("https://" + HOST + "/index.html");
        ui.post(splitWatcher);
    }

    // ------------------------------------------------------------- assets

    /** Serve one request from the APK's assets (or the kept ROM). */
    private WebResourceResponse serve(Uri uri) {
        if (!"https".equals(uri.getScheme()) || !HOST.equals(uri.getHost())) {
            return null; // not ours: let the WebView try (and fail) as usual
        }
        String path = uri.getPath();
        if (path == null || path.isEmpty() || "/".equals(path)) {
            path = "/index.html";
        }
        if (path.contains("..")) {
            return notFound();
        }
        // A folder the player picked (an HD pack), mounted for this session:
        // the page fetches `_hdp/pack.json`, `_hdp/sheets/...` from here.
        if (path.startsWith(HD_ROOT)) {
            return serveHdPack(path.substring(HD_ROOT.length()));
        }
        // The page asks for this only on this origin: its own cartridge, kept
        // in this app's private storage. A file picked later in the app wins
        // over anything the build put in the APK, so "Choose ROM file…" always
        // upgrades what the next launch loads.
        if (path.startsWith("/_rom/")) {
            File rom = new File(storageDir, ROM_NAME);
            if (rom.isFile()) {
                return fromFile(rom);
            }
            // Fallback, and only if a build staged one: `Z2_APK_ROM` puts the
            // user's own dump in the assets (see app/build.gradle).
            try {
                return respond(ROM_NAME, getAssets().open(ASSETS + ROM_NAME), 200, "OK");
            } catch (IOException e) {
                return notFound();
            }
        }
        String asset = ASSETS + path.substring(1);
        try {
            return respond(asset, getAssets().open(asset), 200, "OK");
        } catch (IOException e) {
            return notFound();
        }
    }

    private WebResourceResponse fromFile(File file) {
        try {
            return respond(file.getName(), new FileInputStream(file), 200, "OK");
        } catch (FileNotFoundException e) {
            return notFound();
        }
    }

    // ---------------------------------------------------------- HD pack folder

    /** Ask for a directory (the pack root: the folder holding pack.json). */
    private void pickHdPack() {
        Intent pick = new Intent(Intent.ACTION_OPEN_DOCUMENT_TREE);
        pick.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
        try {
            startActivityForResult(pick, REQ_PICK_HD);
        } catch (ActivityNotFoundException e) {
            Log.w(TAG, "no folder picker");
        }
    }

    /**
     * Serve one file out of the picked pack folder.
     *
     * <p>The tree is walked name by name (`sheets/sheet-01.png` is three
     * lookups) because a tree URI addresses documents by id, not by path —
     * and the names asked for are the ones `pack.json` lists.
     */
    private WebResourceResponse serveHdPack(String rel) {
        Uri tree = hdTree;
        if (tree == null || rel.isEmpty()) {
            return notFound();
        }
        String[] parts = rel.split("/");
        String docId = DocumentsContract.getTreeDocumentId(tree);
        for (String part : parts) {
            if (part.isEmpty()) {
                return notFound();
            }
            docId = hdChild(tree, docId, part);
            if (docId == null) {
                return notFound();
            }
        }
        try {
            InputStream in = getContentResolver()
                    .openInputStream(DocumentsContract.buildDocumentUriUsingTree(tree, docId));
            if (in == null) {
                return notFound();
            }
            return respond(parts[parts.length - 1], in, 200, "OK");
        } catch (IOException | SecurityException e) {
            Log.w(TAG, "cannot read " + rel + " from the pack folder: " + e);
            return notFound();
        }
    }

    /** Document id of `name` inside `parentDocId`, or null. */
    private String hdChild(Uri tree, String parentDocId, String name) {
        Uri children = DocumentsContract.buildChildDocumentsUriUsingTree(tree, parentDocId);
        String[] cols = {
                DocumentsContract.Document.COLUMN_DOCUMENT_ID,
                DocumentsContract.Document.COLUMN_DISPLAY_NAME,
        };
        try (Cursor c = getContentResolver().query(children, cols, null, null, null)) {
            while (c != null && c.moveToNext()) {
                if (name.equals(c.getString(1))) {
                    return c.getString(0);
                }
            }
        } catch (SecurityException e) {
            Log.w(TAG, "cannot list the pack folder: " + e);
        }
        return null;
    }

    private static WebResourceResponse respond(String name, InputStream data, int code, String why) {
        String mime = mimeFor(name);
        // Text gets an encoding; binaries (wasm, images) must not, or WebView
        // decodes the bytes and the bundle is garbage.
        String encoding = mime.startsWith("text/") || "application/json".equals(mime) ? "UTF-8" : null;
        Map<String, String> headers = new HashMap<>();
        headers.put("Cache-Control", "no-store");
        return new WebResourceResponse(mime, encoding, code, why, headers, data);
    }

    private static WebResourceResponse notFound() {
        byte[] body = "404".getBytes(StandardCharsets.UTF_8);
        return new WebResourceResponse("text/plain", "UTF-8", 404, "Not Found",
                new HashMap<String, String>(), new ByteArrayInputStream(body));
    }

    private static String mimeFor(String name) {
        String lower = name.toLowerCase(Locale.ROOT);
        if (lower.endsWith(".html")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json")) return "application/json";
        // Required: wasm only streams when the type is exactly this.
        if (lower.endsWith(".wasm")) return "application/wasm";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".txt")) return "text/plain";
        return "application/octet-stream";
    }

    // ---------------------------------------------------------------- ROM

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_PICK_HD) {
            Uri uri = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
            if (uri == null) {
                return;
            }
            hdTree = uri;
            // Only some providers grant across launches; either way this
            // session can read the folder, which is what loading needs.
            try {
                getContentResolver()
                        .takePersistableUriPermission(uri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            } catch (SecurityException e) {
                Log.i(TAG, "pack folder grant is not persistable: " + e);
            }
            Log.i(TAG, "HD pack folder mounted at " + HD_ROOT);
            return;
        }
        if (requestCode != REQ_PICK_ROM) {
            super.onActivityResult(requestCode, resultCode, data);
            return;
        }
        Uri[] chosen = null;
        Uri uri = (resultCode == RESULT_OK && data != null) ? data.getData() : null;
        if (uri != null) {
            chosen = new Uri[]{uri};
            keepRom(uri); // so the next launch does not have to pick it again
        }
        ValueCallback<Uri[]> callback = fileCallback;
        fileCallback = null;
        if (callback != null) {
            callback.onReceiveValue(chosen);
        }
    }

    /**
     * Copy the chosen ROM into this app's private storage. Only a file that
     * opens with the iNES magic is kept; the page hash-gates it again anyway,
     * this just stops a mis-pick from being remembered as the cartridge.
     */
    private void keepRom(Uri uri) {
        File target = new File(storageDir, ROM_NAME);
        File staged = new File(storageDir, ROM_NAME + ".part");
        InputStream in = null;
        FileOutputStream out = null;
        boolean ok = false;
        try {
            in = getContentResolver().openInputStream(uri);
            if (in == null) {
                return;
            }
            byte[] head = new byte[4];
            int got = 0;
            while (got < head.length) {
                int n = in.read(head, got, head.length - got);
                if (n < 0) {
                    return;
                }
                got += n;
            }
            if (head[0] != 'N' || head[1] != 'E' || head[2] != 'S' || head[3] != 0x1A) {
                Log.i(TAG, "picked file is not an iNES ROM; not keeping it");
                return;
            }
            out = new FileOutputStream(staged);
            out.write(head);
            byte[] buf = new byte[64 * 1024];
            long total = head.length;
            int n;
            while ((n = in.read(buf)) > 0) {
                total += n;
                if (total > MAX_ROM_BYTES) {
                    Log.i(TAG, "picked file is too large to keep");
                    return;
                }
                out.write(buf, 0, n);
            }
            out.flush();
            ok = true;
        } catch (IOException e) {
            Log.w(TAG, "cannot keep the ROM: " + e);
        } finally {
            if (out != null) {
                try {
                    out.close();
                } catch (IOException ignored) {
                    // nothing useful left to do
                }
            }
            if (in != null) {
                try {
                    in.close();
                } catch (IOException ignored) {
                    // nothing useful left to do
                }
            }
        }
        if (ok) {
            if (target.exists() && !target.delete()) {
                Log.w(TAG, "cannot replace the kept ROM");
            }
            if (!staged.renameTo(target)) {
                Log.w(TAG, "cannot move the kept ROM into place");
            } else {
                Log.i(TAG, "kept the ROM for the next launch");
            }
        } else if (staged.exists()) {
            //noinspection ResultOfMethodCallIgnored
            staged.delete();
        }
    }

    // -------------------------------------------------------- orientation

    /**
     * While the portrait two-player split is on, hold the device upright —
     * two stacked halves are what the picture is, and a rotated screen would
     * put player 2's controls off the end of it. Asked of the page rather
     * than mirrored here, because only the page knows when co-op turned on.
     */
    private final Runnable splitWatcher = new Runnable() {
        @Override
        public void run() {
            if (isFinishing() || isDestroyed() || webView == null) {
                return;
            }
            webView.evaluateJavascript(
                    "!!(window.z2&&window.z2.ext&&window.z2.ext.split&&window.z2.ext.split.on())",
                    new ValueCallback<String>() {
                        @Override
                        public void onReceiveValue(String value) {
                            boolean on = "true".equals(value);
                            if (on == splitPortrait || isFinishing() || isDestroyed()) {
                                return;
                            }
                            splitPortrait = on;
                            setRequestedOrientation(on
                                    ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT
                                    : ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR);
                        }
                    });
            ui.postDelayed(this, ORIENT_EVERY_MS);
        }
    };

    // ------------------------------------------------------------ lifecycle

    @Override
    @SuppressWarnings("deprecation") // the platform replacement needs a listener API 30+
    public void onBackPressed() {
        if (webView != null && webView.canGoBack()) {
            webView.goBack();
        } else {
            super.onBackPressed();
        }
    }

    @Override
    protected void onDestroy() {
        ui.removeCallbacks(splitWatcher);
        if (fileCallback != null) {
            fileCallback.onReceiveValue(null);
            fileCallback = null;
        }
        if (webView != null) {
            webView.destroy();
            webView = null;
        }
        super.onDestroy();
    }
}
