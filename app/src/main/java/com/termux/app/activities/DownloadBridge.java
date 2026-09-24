package com.termux.app.activities;

import android.content.ContentValues;
import android.content.Context;
import android.net.Uri;
import android.os.Build;
import android.os.Handler;
import android.os.Looper;
import android.provider.MediaStore;
import android.util.Base64;
import android.webkit.JavascriptInterface;
import android.webkit.URLUtil;
import android.widget.Toast;

import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStream;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;

/** WebToApp DownloadBridge 媒体下载模块的 Java 版：blob/data 经 JS 桥取回，分块大文件支持，纯 Toast 无日志 */
public class DownloadBridge {

    private final Context mContext;
    private final Handler mMain = new Handler(Looper.getMainLooper());
    private final ConcurrentHashMap<String, Chunk> mChunks = new ConcurrentHashMap<>();

    private static class Chunk {
        final String filename;
        final String mimeType;
        final File tempFile;
        final OutputStream out;
        Chunk(String f, String m, File t, OutputStream o) { filename = f; mimeType = m; tempFile = t; out = o; }
    }

    DownloadBridge(Context context) { mContext = context.getApplicationContext(); }

    public static String getInjectionJs(Context context) {
        try {
            java.io.InputStream in = context.getAssets().open("wta_inject.js");
            java.io.ByteArrayOutputStream bos = new java.io.ByteArrayOutputStream();
            byte[] buf = new byte[8192]; int n;
            while ((n = in.read(buf)) > 0) bos.write(buf, 0, n);
            in.close();
            return bos.toString("UTF-8");
        } catch (Exception e) { return ""; }
    }

    private void toast(String msg) {
        mMain.post(() -> Toast.makeText(mContext, msg, Toast.LENGTH_SHORT).show());
    }

    @JavascriptInterface
    public void showToast(String message) { toast(message == null ? "" : message); }

    @JavascriptInterface
    public String getDownloadPath() { return "Download/本地酒馆"; }

    @JavascriptInterface
    public String startChunkedDownload(String filename, String mimeType, long totalSize) {
        String id = UUID.randomUUID().toString();
        try {
            String safe = sanitize(filename);
            File tmp = new File(mContext.getCacheDir(), "dl_" + id + "_" + safe);
            FileOutputStream out = new FileOutputStream(tmp);
            mChunks.put(id, new Chunk(safe, mimeType == null ? "" : mimeType, tmp, out));
        } catch (Exception e) {
            toast("无法写入文件");
        }
        return id;
    }

    @JavascriptInterface
    public void appendChunk(String downloadId, String base64Chunk, int chunkIndex, int totalChunks) {
        Chunk c = mChunks.get(downloadId);
        if (c == null) return;
        try {
            c.out.write(Base64.decode(base64Chunk, Base64.DEFAULT));
        } catch (Exception e) {
            mChunks.remove(downloadId);
            try { c.out.close(); c.tempFile.delete(); } catch (Exception ignored) {}
            toast("读取文件失败");
        }
    }

    @JavascriptInterface
    public void finishChunkedDownload(String downloadId) {
        Chunk c = mChunks.remove(downloadId);
        if (c == null) return;
        try {
            c.out.close();
            byte[] bytes = java.nio.file.Files.readAllBytes(c.tempFile.toPath());
            String saved = insert(c.filename, c.mimeType, bytes);
            c.tempFile.delete();
            toast(saved);
        } catch (Exception e) {
            c.tempFile.delete();
            toast("保存失败");
        }
    }

    @JavascriptInterface
    public void saveBase64File(String dataUrl, String filename, String mimeType) {
        try {
            String b64 = dataUrl != null && dataUrl.contains("base64,")
                ? dataUrl.substring(dataUrl.indexOf("base64,") + 7) : (dataUrl == null ? "" : dataUrl);
            byte[] bytes = Base64.decode(b64, Base64.DEFAULT);
            String mime = mimeType == null || mimeType.trim().isEmpty() ? "application/octet-stream" : mimeType.split(";")[0].trim();
            String name = filename == null || filename.trim().isEmpty()
                ? "tavern_" + System.currentTimeMillis() + extFor(mime) : sanitize(filename);
            final String saved = insert(name, mime, bytes);
            mMain.post(() -> Toast.makeText(mContext, saved, Toast.LENGTH_SHORT).show());
        } catch (Exception e) {
            toast("保存失败：" + (e.getMessage() != null ? e.getMessage() : "未知错误"));
        }
    }

    private String insert(String filename, String mime, byte[] bytes) throws Exception {
        boolean isImage = mime.startsWith("image/");
        boolean isVideo = mime.startsWith("video/");
        boolean isAudio = mime.startsWith("audio/");
        ContentValues cv = new ContentValues();
        cv.put(MediaStore.MediaColumns.DISPLAY_NAME, filename);
        cv.put(MediaStore.MediaColumns.MIME_TYPE, mime);
        Uri uri;
        if (isImage) {
            cv.put(MediaStore.Images.Media.RELATIVE_PATH, "Pictures/本地酒馆");
            uri = mContext.getContentResolver().insert(MediaStore.Images.Media.EXTERNAL_CONTENT_URI, cv);
        } else if (isVideo) {
            cv.put(MediaStore.Video.Media.RELATIVE_PATH, "Movies/本地酒馆");
            uri = mContext.getContentResolver().insert(MediaStore.Video.Media.EXTERNAL_CONTENT_URI, cv);
        } else if (isAudio) {
            cv.put(MediaStore.Audio.Media.RELATIVE_PATH, "Music/本地酒馆");
            uri = mContext.getContentResolver().insert(MediaStore.Audio.Media.EXTERNAL_CONTENT_URI, cv);
        } else {
            cv.put(MediaStore.Downloads.RELATIVE_PATH, "Download/本地酒馆");
            uri = mContext.getContentResolver().insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
        }
        if (uri == null) throw new IllegalStateException("写入被拒绝");
        OutputStream os = mContext.getContentResolver().openOutputStream(uri);
        os.write(bytes);
        os.close();
        if (isImage) return "图片已保存到 相册/Pictures/本地酒馆：" + filename;
        if (isVideo) return "视频已保存到 Movies/本地酒馆：" + filename;
        if (isAudio) return "音频已保存到 Music/本地酒馆：" + filename;
        return "已保存到 Download/本地酒馆：" + filename;
    }

    private static String sanitize(String name) {
        if (name == null || name.trim().isEmpty()) return "download_" + System.currentTimeMillis();
        String s = name.replaceAll("[\\\\/:*?\"<>|]", "_");
        if (s.length() > 200) {
            String ext = s.contains(".") ? s.substring(s.lastIndexOf('.') + 1) : "";
            s = ext.isEmpty() ? s.substring(0, 200) : s.substring(0, 190) + "." + ext;
        }
        return s;
    }

    private static String extFor(String mime) {
        if (mime.startsWith("video/")) return mime.contains("webm") ? ".webm" : ".mp4";
        if (mime.startsWith("audio/")) {
            if (mime.contains("mpeg")) return ".mp3";
            if (mime.contains("ogg")) return ".ogg";
            if (mime.contains("wav")) return ".wav";
            return ".m4a";
        }
        if (mime.contains("pdf")) return ".pdf";
        if (mime.contains("zip")) return ".zip";
        if (mime.contains("json")) return ".json";
        if (mime.startsWith("text/")) return mime.contains("html") ? ".html" : ".txt";
        return ".bin";
    }
}
