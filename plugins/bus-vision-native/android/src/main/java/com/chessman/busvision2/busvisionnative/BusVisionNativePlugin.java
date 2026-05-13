package com.chessman.busvision2.busvisionnative;

import android.Manifest;
import android.content.pm.PackageManager;
import android.util.Log;
import android.net.Uri;
import android.content.ClipData;
import android.content.Intent;

import androidx.core.content.FileProvider;

import com.getcapacitor.JSArray;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.util.zip.ZipEntry;
import java.util.zip.ZipOutputStream;

import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

@CapacitorPlugin(
  name = "BusVisionNative",
  permissions = {
    @Permission(alias = "camera", strings = { Manifest.permission.CAMERA }),
    @Permission(alias = "microphone", strings = { Manifest.permission.RECORD_AUDIO })
  }
)
public class BusVisionNativePlugin extends Plugin {
  private static final String TAG = "BusVisionNative";

  private NativeCameraHost getHostOrNull() {
    NativeCameraHost host = NativeCameraHost.getInstance();
    if (host == null) Log.e(TAG, "NativeCameraHost is not ready yet");
    return host;
  }

  private boolean rejectIfHostMissing(PluginCall call, NativeCameraHost host) {
    if (host == null) {
      call.reject("native_host_not_ready");
      return true;
    }
    return false;
  }


  private JSObject focusToJson(String afState, Float focusDiopters, Double meters, String confidence) {
    JSObject ret = new JSObject();
    ret.put("afState", afState != null ? afState : "UNKNOWN");
    if (focusDiopters != null) ret.put("focusDistanceDiopters", focusDiopters.doubleValue());
    if (meters != null) ret.put("estimatedMeters", meters);
    ret.put("distanceConfidence", confidence != null ? confidence : "unavailable");
    return ret;
  }



  private JSObject arCoreStatusToJson() {
    JSObject ret = new JSObject();
    boolean installed = false;
    try {
      getContext().getPackageManager().getPackageInfo("com.google.ar.core", 0);
      installed = true;
    } catch (PackageManager.NameNotFoundException ignored) {
      installed = false;
    } catch (Throwable ignored) {
      installed = false;
    }
    ret.put("installed", installed);
    // 這裡先做可用性偵測與 fallback 管線。真正 ARCore Depth frame 需要 AR Session 接管相機；
    // 本 App 目前主相機管線是 CameraX，因此若沒有啟動 AR Session，會自動降級到 focusDistance。
    ret.put("available", installed);
    ret.put("depthSupported", false);
    ret.put("status", installed ? "cameraX_mode_arcore_depth_requires_dedicated_ar_session" : "arcore_not_installed");
    return ret;
  }

  private JSObject distanceEstimateToJson(String afState, Float focusDiopters, Double meters, String confidence, float x, float y, String manualTag, String warning) {
    JSObject ret = focusToJson(afState, focusDiopters, meters, confidence);
    JSObject arcore = arCoreStatusToJson();
    boolean arDepthSupported = false;
    String source;
    String finalConfidence = confidence != null ? confidence : "unavailable";
    Double finalMeters = null;
    if (arDepthSupported) {
      source = "arcore_depth";
      finalConfidence = "high";
    } else if (meters != null) {
      source = "focus_distance";
      finalMeters = meters;
    } else if (manualTag != null && !manualTag.trim().isEmpty() && !"auto".equals(manualTag)) {
      source = "manual_label";
      finalConfidence = "low";
    } else {
      source = "unavailable";
      finalConfidence = "unavailable";
    }
    ret.put("ok", true);
    ret.put("tapX", x);
    ret.put("tapY", y);
    ret.put("distanceSource", source);
    if (finalMeters != null) ret.put("finalDistanceMeters", finalMeters);
    ret.put("distanceConfidence", finalConfidence);
    ret.put("manualDistanceLabel", manualTag != null ? manualTag : "auto");
    ret.put("arcore", arcore);
    ret.put("pipeline", new String[] { "arcore_depth", "focus_distance", "manual_label" });
    ret.put("timestamp", System.currentTimeMillis());
    if (warning != null) ret.put("warning", warning);
    return ret;
  }



  private String safeZipName(String raw) {
    String name = raw != null ? raw.trim() : "busvision_export.zip";
    name = name.replaceAll("[^a-zA-Z0-9._-]+", "_");
    if (!name.endsWith(".zip")) name = name + ".zip";
    return name.length() > 96 ? name.substring(0, 92) + ".zip" : name;
  }

  private File resolveDataFile(String path) {
    if (path == null || path.trim().isEmpty()) return null;
    String p = path.trim();
    if (p.startsWith("file://")) p = Uri.parse(p).getPath();
    File f = new File(p);
    if (f.isAbsolute()) return f;
    return new File(getContext().getFilesDir(), p);
  }

  private String safeEntryName(String raw) {
    String name = raw != null ? raw.trim() : "file";
    name = name.replace('\\', '/').replaceAll("^/+", "");
    name = name.replace("../", "").replace("/..", "");
    return name.isEmpty() ? "file" : name;
  }

  private void launchShareSheet(Uri uri, String zipName) {
    try {
      Intent sendIntent = new Intent(Intent.ACTION_SEND);
      sendIntent.setType("application/zip");
      sendIntent.putExtra(Intent.EXTRA_STREAM, uri);
      sendIntent.putExtra(Intent.EXTRA_SUBJECT, zipName);
      sendIntent.putExtra(Intent.EXTRA_TEXT, "Bus Vision dataset export: " + zipName);
      sendIntent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      sendIntent.setClipData(ClipData.newUri(getContext().getContentResolver(), zipName, uri));

      Intent chooser = Intent.createChooser(sendIntent, "匯出資料集 ZIP");
      chooser.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
      chooser.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
      getActivity().startActivity(chooser);
    } catch (Exception e) {
      Log.e(TAG, "share ZIP failed", e);
    }
  }

  @PluginMethod
  public void exportZip(PluginCall call) {
    String zipName = safeZipName(call.getString("zipName", "busvision_export.zip"));
    boolean share = call.getBoolean("share", false);
    JSArray files = call.getArray("files");
    if (files == null || files.length() == 0) {
      call.reject("沒有可匯出的檔案");
      return;
    }

    new Thread(() -> {
      int count = 0;
      try {
        File exportDir = new File(getContext().getCacheDir(), "BusExports");
        if (!exportDir.exists() && !exportDir.mkdirs()) throw new Exception("無法建立匯出資料夾");
        File outFile = new File(exportDir, zipName);
        byte[] buffer = new byte[1024 * 64];

        try (ZipOutputStream zos = new ZipOutputStream(new BufferedOutputStream(new FileOutputStream(outFile)))) {
          for (int i = 0; i < files.length(); i++) {
            JSONObject obj = files.getJSONObject(i);
            if (obj == null) continue;
            String entryName = safeEntryName(obj.optString("name", "file_" + i));
            ZipEntry entry = new ZipEntry(entryName);
            zos.putNextEntry(entry);

            String sourcePath = obj.optString("sourcePath", null);
            if (sourcePath != null && !sourcePath.trim().isEmpty()) {
              File source = resolveDataFile(sourcePath);
              if (source == null || !source.exists() || !source.isFile()) {
                zos.closeEntry();
                continue;
              }
              try (InputStream in = new BufferedInputStream(new FileInputStream(source))) {
                int n;
                while ((n = in.read(buffer)) >= 0) {
                  if (n > 0) zos.write(buffer, 0, n);
                }
              }
            } else {
              String text = obj.optString("text", "");
              try (InputStream in = new ByteArrayInputStream(text.getBytes(StandardCharsets.UTF_8))) {
                int n;
                while ((n = in.read(buffer)) >= 0) {
                  if (n > 0) zos.write(buffer, 0, n);
                }
              }
            }
            zos.closeEntry();
            count++;
          }
        }

        Uri uri = FileProvider.getUriForFile(getContext(), getContext().getPackageName() + ".fileprovider", outFile);
        if (share) {
          getActivity().runOnUiThread(() -> launchShareSheet(uri, zipName));
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("uri", uri.toString());
        ret.put("path", outFile.getAbsolutePath());
        ret.put("count", count);
        ret.put("sizeBytes", outFile.length());
        ret.put("shared", share);
        call.resolve(ret);
      } catch (Exception e) {
        Log.e(TAG, "exportZip failed", e);
        call.reject("匯出 ZIP 失敗：" + e.getMessage());
      }
    }).start();
  }


  @PluginMethod
  public void isNativeAvailable(PluginCall call) {
    JSObject ret = new JSObject();
    ret.put("available", getHostOrNull() != null);
    call.resolve(ret);
  }

  @PluginMethod
  public void ensurePermissions(PluginCall call) {
    if (getPermissionState("camera") != PermissionState.GRANTED ||
        getPermissionState("microphone") != PermissionState.GRANTED) {
      requestAllPermissions(call, "completePermissionRequest");
      return;
    }
    resolvePermissionState(call);
  }

  @PermissionCallback
  private void completePermissionRequest(PluginCall call) {
    resolvePermissionState(call);
  }

  private void resolvePermissionState(PluginCall call) {
    JSObject ret = new JSObject();
    String camera = getPermissionState("camera").toString().toLowerCase();
    String microphone = getPermissionState("microphone").toString().toLowerCase();
    ret.put("ok", "granted".equals(camera) && "granted".equals(microphone));
    ret.put("camera", camera);
    ret.put("microphone", microphone);
    ret.put("mic", microphone);
    call.resolve(ret);
  }

  @PluginMethod
  public void startCamera(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      NativeCameraHost host = getHostOrNull();
      if (rejectIfHostMissing(call, host)) return;
      host.startPreview(new NativeCameraHost.SimpleCallback() {
        @Override public void ok() {
          JSObject ret = new JSObject();
          ret.put("ok", true);
          call.resolve(ret);
        }
        @Override public void err(String msg) { call.reject(msg); }
      });
    });
  }

  @PluginMethod
  public void stopCamera(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      NativeCameraHost host = getHostOrNull();
      if (rejectIfHostMissing(call, host)) return;
      host.stopPreview();
      JSObject ret = new JSObject();
      ret.put("ok", true);
      call.resolve(ret);
    });
  }

  @PluginMethod
  public void startRecording(PluginCall call) {
    int sampleRate = call.getInt("sampleRate", 48000);
    int channels = call.getInt("channels", 1);
    getActivity().runOnUiThread(() -> {
      NativeCameraHost host = getHostOrNull();
      if (rejectIfHostMissing(call, host)) return;
      host.startRecording(sampleRate, channels, new NativeCameraHost.SimpleCallback() {
        @Override public void ok() {
          JSObject ret = new JSObject();
          ret.put("ok", true);
          call.resolve(ret);
        }
        @Override public void err(String msg) { call.reject(msg); }
      });
    });
  }

  @PluginMethod
  public void stopRecording(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      NativeCameraHost host = getHostOrNull();
      if (rejectIfHostMissing(call, host)) return;
      host.stopRecording((ok, videoPath, audioPath, durationMs, iso, exposureTimeNs, err) -> {
        if (!ok) {
          call.reject(err != null ? err : "stopRecording failed");
          return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("path", videoPath);
        ret.put("audioPath", audioPath);
        ret.put("filename", NativeCameraHost.basename(videoPath));
        ret.put("audioFilename", NativeCameraHost.basename(audioPath));
        ret.put("mimeType", "video/mp4");
        ret.put("durationMs", durationMs);
        JSObject camMeta = new JSObject();
        if (iso != null) camMeta.put("iso", iso);
        if (exposureTimeNs != null) camMeta.put("exposureTimeNs", exposureTimeNs);
        NativeCameraHost.FocusSnapshot snap = host.getFocusSnapshot();
        camMeta.put("focus", focusToJson(snap.afState, snap.focusDistanceDiopters, snap.estimatedMeters, snap.confidence));
        if (snap.focalLengthMm != null) camMeta.put("focalLengthMm", snap.focalLengthMm.doubleValue());
        if (snap.minFocusDistanceDiopters != null) camMeta.put("minFocusDistanceDiopters", snap.minFocusDistanceDiopters.doubleValue());
        camMeta.put("device", NativeCameraHost.buildDeviceString(getContext()));
        camMeta.put("photoFlashMode", host.getPhotoFlashMode());
        camMeta.put("exposureCompensationIndex", host.getExposureCompensationIndex());
        ret.put("cameraMeta", camMeta);
        call.resolve(ret);
      });
    });
  }

  @PluginMethod
  public void takePhoto(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      NativeCameraHost host = getHostOrNull();
      if (rejectIfHostMissing(call, host)) return;
      String filename = call.getString("filename", null);
      host.takePhoto(filename, (ok, path, err) -> {
        if (!ok) {
          call.reject(err != null ? err : "takePhoto failed");
          return;
        }
        JSObject ret = new JSObject();
        ret.put("ok", true);
        ret.put("path", path);
        ret.put("filename", NativeCameraHost.basename(path));
        ret.put("mimeType", "image/jpeg");
        JSObject camMeta = new JSObject();
        NativeCameraHost.FocusSnapshot snap = host.getFocusSnapshot();
        camMeta.put("focus", focusToJson(snap.afState, snap.focusDistanceDiopters, snap.estimatedMeters, snap.confidence));
        if (snap.focalLengthMm != null) camMeta.put("focalLengthMm", snap.focalLengthMm.doubleValue());
        if (snap.minFocusDistanceDiopters != null) camMeta.put("minFocusDistanceDiopters", snap.minFocusDistanceDiopters.doubleValue());
        camMeta.put("device", NativeCameraHost.buildDeviceString(getContext()));
        camMeta.put("photoFlashMode", host.getPhotoFlashMode());
        camMeta.put("exposureCompensationIndex", host.getExposureCompensationIndex());
        ret.put("cameraMeta", camMeta);
        call.resolve(ret);
      });
    });
  }


  @PluginMethod
  public void tapToFocus(PluginCall call) {
    double x = call.getDouble("x", 0.5);
    double y = call.getDouble("y", 0.5);
    getActivity().runOnUiThread(() -> {
      NativeCameraHost host = getHostOrNull();
      if (rejectIfHostMissing(call, host)) return;
      host.tapToFocus((float) x, (float) y, (ok, fx, fy, afState, focusDiopters, meters, confidence, err) -> {
        if (!ok && err != null && err.startsWith("camera_permission")) {
          call.reject(err);
          return;
        }
        JSObject ret = focusToJson(afState, focusDiopters, meters, confidence);
        ret.put("ok", ok);
        ret.put("tapX", fx);
        ret.put("tapY", fy);
        ret.put("timestamp", System.currentTimeMillis());
        if (err != null) ret.put("warning", err);
        call.resolve(ret);
      });
    });
  }


  @PluginMethod
  public void getDistanceEstimate(PluginCall call) {
    double x = call.getDouble("x", 0.5);
    double y = call.getDouble("y", 0.5);
    String manualTag = call.getString("manualTag", "auto");
    getActivity().runOnUiThread(() -> {
      NativeCameraHost host = getHostOrNull();
      if (rejectIfHostMissing(call, host)) return;
      host.tapToFocus((float) x, (float) y, (ok, fx, fy, afState, focusDiopters, meters, confidence, err) -> {
        if (!ok && err != null && err.startsWith("camera_permission")) {
          call.reject(err);
          return;
        }
        JSObject ret = distanceEstimateToJson(afState, focusDiopters, meters, confidence, fx, fy, manualTag, err);
        call.resolve(ret);
      });
    });
  }

  @PluginMethod
  public void getFocusInfo(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      NativeCameraHost host = getHostOrNull();
      if (rejectIfHostMissing(call, host)) return;
      NativeCameraHost.FocusSnapshot snap = host.getFocusSnapshot();
      JSObject ret = focusToJson(snap.afState, snap.focusDistanceDiopters, snap.estimatedMeters, snap.confidence);
      ret.put("ok", true);
      if (snap.focalLengthMm != null) ret.put("focalLengthMm", snap.focalLengthMm.doubleValue());
      if (snap.minFocusDistanceDiopters != null) ret.put("minFocusDistanceDiopters", snap.minFocusDistanceDiopters.doubleValue());
      call.resolve(ret);
    });
  }

  @PluginMethod
  public void setPhotoFlashMode(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      NativeCameraHost host = getHostOrNull();
      if (rejectIfHostMissing(call, host)) return;
      String mode = call.getString("mode", "off");
      JSObject ret = new JSObject();
      ret.put("ok", host.setPhotoFlashMode(mode));
      ret.put("mode", host.getPhotoFlashMode());
      call.resolve(ret);
    });
  }

  @PluginMethod
  public void setExposureCompensation(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      NativeCameraHost host = getHostOrNull();
      if (rejectIfHostMissing(call, host)) return;
      int index = call.getInt("index", 0);
      JSObject ret = new JSObject();
      ret.put("ok", host.setExposureCompensation(index));
      ret.put("index", host.getExposureCompensationIndex());
      call.resolve(ret);
    });
  }

  @PluginMethod
  public void setTorch(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      NativeCameraHost host = getHostOrNull();
      if (rejectIfHostMissing(call, host)) return;
      boolean enabled = call.getBoolean("enabled", false);
      JSObject ret = new JSObject();
      ret.put("ok", host.setTorch(enabled));
      call.resolve(ret);
    });
  }

  @PluginMethod
  public void setZoom(PluginCall call) {
    getActivity().runOnUiThread(() -> {
      NativeCameraHost host = getHostOrNull();
      if (rejectIfHostMissing(call, host)) return;
      double ratio = call.getDouble("ratio", 1.0);
      JSObject ret = new JSObject();
      ret.put("ok", host.setZoom((float) ratio));
      call.resolve(ret);
    });
  }
}
