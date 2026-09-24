package com.termux.app.activities;

import android.annotation.SuppressLint;
import android.content.Intent;
import android.content.ContentValues;
import android.content.Context;
import android.os.Build;
import android.provider.MediaStore;
import android.app.AlertDialog;
import android.webkit.CookieManager;
import android.webkit.URLUtil;
import android.widget.Toast;
import android.graphics.Color;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.FrameLayout;
import android.widget.TextView;

import androidx.appcompat.app.AppCompatActivity;

import com.termux.R;
import com.termux.shared.termux.settings.properties.TermuxAppSharedProperties;

/** 内置浏览器：WebView；支持文件选择与媒体下载 */
public class WebActivity extends AppCompatActivity {

    private WebView mWebView;
    private FrameLayout mRoot;
    private String mUrl;
    private android.webkit.ValueCallback<android.net.Uri[]> mFileCallback;
    private DownloadBridge mDownloadBridge;
    private View mCustomView;
    private WebChromeClient.CustomViewCallback mCustomCb;
    private static final int REQ_FILE = 1001;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        int port = getSharedPreferences("app", MODE_PRIVATE).getInt("server_port", 8000);
        mUrl = getIntent() != null && getIntent().getDataString() != null
            ? getIntent().getDataString() : "http://127.0.0.1:" + port + "/";

        mRoot = new FrameLayout(this);
        mWebView = new WebView(this);
        // 酒馆同款全屏
        hideSystemBars();
        mWebView.getSettings().setJavaScriptEnabled(true);
        mWebView.getSettings().setDomStorageEnabled(true);
        // 媒体自动播放（酒馆音效/语音）：不需要用户手势
        mWebView.getSettings().setMediaPlaybackRequiresUserGesture(false);
        // 硬件加速渲染优先级：动画期间提升
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            mWebView.setRendererPriorityPolicy(android.webkit.WebView.RENDERER_PRIORITY_IMPORTANT, true);
        }
        mWebView.getSettings().setUseWideViewPort(true);
        mWebView.getSettings().setLoadWithOverviewMode(true);
        // 深色模式：默认开启（WebView 强制暗化渲染）
        mWebView.getSettings().setForceDark(android.webkit.WebSettings.FORCE_DARK_ON);
        // WebToApp 媒体下载模块：blob/data 经 JS 桥取回
        mDownloadBridge = new DownloadBridge(this);
        mWebView.addJavascriptInterface(mDownloadBridge, "AndroidDownload");

        mWebView.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onShowFileChooser(WebView view, android.webkit.ValueCallback<android.net.Uri[]> callback,
                    WebChromeClient.FileChooserParams params) {
                if (mFileCallback != null) mFileCallback.onReceiveValue(null);
                mFileCallback = callback;
                try {
                    Intent i = new Intent(Intent.ACTION_GET_CONTENT);
                    i.addCategory(Intent.CATEGORY_OPENABLE);
                    i.setType("*/*");
                    i.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true);
                    // 选择存储=shared 时，文件选择器定位到 /storage/emulated/0/
                    String mode = getSharedPreferences("app", MODE_PRIVATE)
                        .getString("browser_storage_mode", "shared");
                    if ("shared".equals(mode)) {
                        i.putExtra(android.provider.DocumentsContract.EXTRA_INITIAL_URI,
                            android.net.Uri.parse("content://com.android.externalstorage.documents/document/primary:"));
                    }
                    startActivityForResult(Intent.createChooser(i, "选择文件"), REQ_FILE);
                } catch (Exception e) {
                    mFileCallback = null;
                    return false;
                }
                return true;
            }
            // HTML5 全屏支持：酒馆助手"手机全屏"脚本依赖 requestFullscreen
            @Override
            public void onShowCustomView(View view, WebChromeClient.CustomViewCallback callback) {
                if (mCustomView != null) { callback.onCustomViewHidden(); return; }
                mCustomView = view;
                mCustomCb = callback;
                mWebView.setVisibility(View.GONE);
                mRoot.addView(view, new FrameLayout.LayoutParams(
                    ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
            }
            @Override
            public void onHideCustomView() {
                exitFullscreen();
            }
        });
        // 长按图片弹出保存；下载链接直接入相册（v27 同款）
        mWebView.setOnLongClickListener(v -> {
            WebView.HitTestResult hit = mWebView.getHitTestResult();
            String src = hit == null ? null : hit.getExtra();
            if ((hit != null && (hit.getType() == WebView.HitTestResult.IMAGE_TYPE
                || hit.getType() == WebView.HitTestResult.SRC_IMAGE_ANCHOR_TYPE))
                && src != null && !src.isEmpty()) {
                new AlertDialog.Builder(WebActivity.this)
                    .setTitle("保存")
                    .setMessage(src)
                    .setPositiveButton("保存", (d, w) -> saveFileAsync(src, null))
                    .setNegativeButton("取消", null)
                    .show();
                return true;
            }
            return false;
        });
        mWebView.setDownloadListener((url, uA, cd, mime, len) -> {
            if (url.startsWith("blob:")) {
                Toast.makeText(WebActivity.this, "正在取回文件…", Toast.LENGTH_SHORT).show();
                String quoted = org.json.JSONObject.quote(url);
                String name = URLUtil.guessFileName(url, cd, mime);
                String js = "(function(){fetch(" + quoted + ").then(function(r){return r.blob()}).then(function(b){var fr=new FileReader();fr.onload=function(){window.AndroidDownload&&window.AndroidDownload.saveBase64File(String(fr.result)," + org.json.JSONObject.quote(name) + ",b.type||'')};fr.onerror=function(){window.AndroidDownload&&window.AndroidDownload.showToast('读取文件失败')};fr.readAsDataURL(b)}).catch(function(){window.AndroidDownload&&window.AndroidDownload.showToast('无法获取文件数据')})})();";
                mWebView.evaluateJavascript(js, null);
                return;
            }
            if (url.startsWith("data:") || isImageUrl(url)) {
                saveFileAsync(url, mime);
                return;
            }
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                Toast.makeText(WebActivity.this, "该链接类型不支持直接下载", Toast.LENGTH_SHORT).show();
                return;
            }
            try {
                String fileName = URLUtil.guessFileName(url, cd, mime);
                android.app.DownloadManager.Request req = new android.app.DownloadManager.Request(android.net.Uri.parse(url));
                req.setTitle(fileName);
                req.setDescription("Termux浏览器 媒体下载");
                req.setNotificationVisibility(android.app.DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);
                req.setDestinationInExternalPublicDir(android.os.Environment.DIRECTORY_DOWNLOADS, "本地酒馆/" + fileName);
                req.addRequestHeader("User-Agent", mWebView.getSettings().getUserAgentString());
                String ck = CookieManager.getInstance().getCookie(url);
                if (ck != null) req.addRequestHeader("Cookie", ck);
                if (mWebView.getUrl() != null) req.addRequestHeader("Referer", mWebView.getUrl());
                ((android.app.DownloadManager) getSystemService(DOWNLOAD_SERVICE)).enqueue(req);
                Toast.makeText(WebActivity.this, "开始下载：" + fileName + " → 下载/本地酒馆", Toast.LENGTH_LONG).show();
            } catch (Exception e) {
                Toast.makeText(WebActivity.this, "下载失败：" + (e.getMessage() != null ? e.getMessage() : "未知错误"), Toast.LENGTH_LONG).show();
            }
        });

        mWebView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageStarted(WebView view, String url, android.graphics.Bitmap favicon) {
                String js = DownloadBridge.getInjectionJs(WebActivity.this);
                if (!js.isEmpty()) view.evaluateJavascript(js, null);
            }
            @Override
            public void onPageFinished(WebView view, String url) {
                String js = DownloadBridge.getInjectionJs(WebActivity.this);
                if (!js.isEmpty()) view.evaluateJavascript(js, null);
            }
        });
        mRoot.addView(mWebView, new FrameLayout.LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));

        setContentView(mRoot);
        // 7天未使用清理：WebView缓存/Cookie/DOM（本地酒馆 v2.6 同款，last_used 记 SP）
        android.content.SharedPreferences sp = getSharedPreferences("app", MODE_PRIVATE);
        long lastUsed = sp.getLong("last_used", 0);
        long now = System.currentTimeMillis();
        if (lastUsed > 0 && now - lastUsed > 7L * 24 * 60 * 60 * 1000) {
            mWebView.clearCache(true);
            CookieManager.getInstance().removeAllCookies(null);
            CookieManager.getInstance().flush();
            mWebView.evaluateJavascript(
                "try{localStorage.clear();sessionStorage.clear();}catch(e){}", null);
        }
        sp.edit().putLong("last_used", now).apply();
        mWebView.loadUrl(mUrl);


    }


    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        String url = intent == null ? null : intent.getDataString();
        if (url != null) {
            mUrl = url;
            mWebView.loadUrl(url);
        }
    }

    /** 通用保存：图片 → 相册「Pictures/本地酒馆」；其他文件 → 「Download/本地酒馆」（MediaStore，Android 10+ 免权限） */
    private void saveFileAsync(String src, String mimeHint) {
        final String fsrc = src;
        new Thread(() -> {
            String okMsg = null;
            String errMsg = null;
            try {
                byte[] bytes;
                if (fsrc.startsWith("data:")) {
                    String b64 = fsrc.contains("base64,") ? fsrc.substring(fsrc.indexOf("base64,") + 7) : "";
                    if (b64.isEmpty()) throw new IllegalArgumentException("不支持的 data 格式");
                    bytes = android.util.Base64.decode(b64, android.util.Base64.DEFAULT);
                } else {
                    java.net.URL u = new java.net.URL(fsrc);
                    java.net.HttpURLConnection conn = (java.net.HttpURLConnection) u.openConnection();
                    conn.setConnectTimeout(15000);
                    conn.setReadTimeout(30000);
                    conn.setInstanceFollowRedirects(true);
                    conn.setRequestProperty("User-Agent", mWebView.getSettings().getUserAgentString());
                    String ck = android.webkit.CookieManager.getInstance().getCookie(fsrc);
                    if (ck != null) conn.setRequestProperty("Cookie", ck);
                    try { bytes = conn.getInputStream().readAllBytes(); } finally { conn.disconnect(); }
                }
                String low = fsrc.toLowerCase();
                boolean isImage = low.startsWith("data:image")
                    || low.contains(".jpg") || low.contains(".jpeg") || low.contains(".png")
                    || low.contains(".webp") || low.contains(".gif") || low.contains(".bmp")
                    || low.contains(".avif") || low.contains(".svg")
                    || (mimeHint != null && mimeHint.startsWith("image/"));
                String name = "tavern_" + System.currentTimeMillis();
                String mime = mimeHint != null && mimeHint.trim().length() > 0 ? mimeHint.split(";")[0].trim() : "application/octet-stream";
                if (isImage) {
                    String ext;
                    if (low.contains(".jpg") || low.contains(".jpeg")) ext = "jpg";
                    else if (low.contains(".webp")) ext = "webp";
                    else if (low.contains(".gif")) ext = "gif";
                    else if (low.contains(".bmp")) ext = "bmp";
                    else if (low.contains(".avif")) ext = "avif";
                    else if (low.contains(".svg")) ext = "svg";
                    else ext = "png";
                    name += "." + ext;
                    mime = "image/" + ext;
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Images.Media.DISPLAY_NAME, name);
                    cv.put(MediaStore.Images.Media.MIME_TYPE, mime);
                    if (Build.VERSION.SDK_INT >= 29)
                        cv.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/本地酒馆");
                    android.net.Uri uri = getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) throw new IllegalStateException("相册写入被拒绝");
                    java.io.OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(bytes);
                    os.close();
                    okMsg = "图片已保存到 相册/Pictures/本地酒馆";
                } else {
                    String ext = "";
                    int dot = low.lastIndexOf('.');
                    if (dot > 0 && dot > low.length() - 8 && !low.contains("data:")) ext = low.substring(dot);
                    if (ext.length() > 0) name += ext;
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    cv.put(MediaStore.Downloads.MIME_TYPE, mime);
                    if (Build.VERSION.SDK_INT >= 29) {
                        cv.put(MediaStore.Downloads.RELATIVE_PATH, "Download/本地酒馆");
                    }
                    android.net.Uri uri = getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) throw new IllegalStateException("下载目录写入被拒绝");
                    java.io.OutputStream os = getContentResolver().openOutputStream(uri);
                    os.write(bytes);
                    os.close();
                    okMsg = "已保存到 Download/本地酒馆";
                }
            } catch (Exception e) {
                errMsg = "保存失败：" + (e.getMessage() != null ? e.getMessage() : "未知错误");
            }
            final String o = okMsg, e2 = errMsg;
            runOnUiThread(() -> Toast.makeText(WebActivity.this, o != null ? o : e2, Toast.LENGTH_LONG).show());
        }).start();
    }

    private static boolean isImageUrl(String url) {
        String u = url.toLowerCase();
        String path = u.split("\\?")[0];
        return path.endsWith(".png") || path.endsWith(".jpg") || path.endsWith(".jpeg")
            || path.endsWith(".webp") || path.endsWith(".gif") || path.endsWith(".bmp")
            || path.endsWith(".avif") || path.endsWith(".svg");
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE && mFileCallback != null) {
            android.net.Uri[] results = null;
            if (resultCode == RESULT_OK && data != null) {
                java.util.ArrayList<android.net.Uri> list = new java.util.ArrayList<>();
                if (data.getClipData() != null) {
                    android.content.ClipData clip = data.getClipData();
                    for (int i = 0; i < clip.getItemCount(); i++)
                        list.add(clip.getItemAt(i).getUri());
                } else if (data.getData() != null) {
                    list.add(data.getData());
                }
                results = list.toArray(new android.net.Uri[0]);
            }
            mFileCallback.onReceiveValue(results);
            mFileCallback = null;
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** 酒馆同款全屏（实测有效）：decorView 绑定 controller，onCreate+onFocus 双重隐藏 */
    private void hideSystemBars() {
        androidx.core.view.WindowCompat.setDecorFitsSystemWindows(getWindow(), false);
        getWindow().getAttributes().layoutInDisplayCutoutMode =
            android.view.WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        androidx.core.view.WindowInsetsControllerCompat controller =
            new androidx.core.view.WindowInsetsControllerCompat(getWindow(), getWindow().getDecorView());
        controller.hide(androidx.core.view.WindowInsetsCompat.Type.systemBars());
        controller.setSystemBarsBehavior(
            androidx.core.view.WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) hideSystemBars();
    }

    private void exitFullscreen() {
        if (mCustomView == null) return;
        mRoot.removeView(mCustomView);
        mCustomView = null;
        mWebView.setVisibility(View.VISIBLE);
        if (mCustomCb != null) { mCustomCb.onCustomViewHidden(); mCustomCb = null; }
    }

    @Override
    public void onBackPressed() {
        // 全屏中 → 先退全屏；有历史 → 网页后退；无历史 → 退出浏览器
        if (mCustomView != null) { exitFullscreen(); return; }
        if (mWebView != null && mWebView.canGoBack()) mWebView.goBack();
        else finish();
    }

    @Override
    public boolean onKeyDown(int keyCode, android.view.KeyEvent event) {
        if (keyCode == android.view.KeyEvent.KEYCODE_BACK) return false;
        return super.onKeyDown(keyCode, event);
    }

    @Override
    public boolean onKeyUp(int keyCode, android.view.KeyEvent event) {
        if (keyCode == android.view.KeyEvent.KEYCODE_BACK) return false;
        return super.onKeyUp(keyCode, event);
    }

    @Override
    protected void onDestroy() {
        if (mWebView != null) mWebView.destroy();
        super.onDestroy();
    }
}
