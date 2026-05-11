package com.chessman.busvision2.busvisionnative;

import android.Manifest;
import android.app.Activity;
import android.content.Context;
import android.content.pm.PackageManager;
import android.os.Build;
import android.util.Log;

import android.hardware.camera2.CameraCaptureSession;
import android.hardware.camera2.CameraCharacteristics;
import android.hardware.camera2.CaptureResult;
import android.hardware.camera2.TotalCaptureResult;

import androidx.annotation.NonNull;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.ImageCaptureException;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.FocusMeteringResult;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.camera2.interop.Camera2CameraInfo;
import androidx.camera.camera2.interop.Camera2Interop;
import androidx.camera.camera2.interop.ExperimentalCamera2Interop;
import androidx.camera.video.FallbackStrategy;
import androidx.camera.video.FileOutputOptions;
import androidx.camera.video.Quality;
import androidx.camera.video.QualitySelector;
import androidx.camera.video.Recorder;
import androidx.camera.video.Recording;
import androidx.camera.video.VideoCapture;
import androidx.camera.video.VideoRecordEvent;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;
import androidx.lifecycle.LifecycleOwner;

import com.google.common.util.concurrent.ListenableFuture;

import java.io.File;
import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

@ExperimentalCamera2Interop
public class NativeCameraHost {
  private static final String TAG = "BusVisionCam";
  private static NativeCameraHost sharedInstance = null;

  public static NativeCameraHost getInstance() { return sharedInstance; }

  private final Activity activity;
  private final Executor mainExecutor;
  private PreviewView previewView;
  private ProcessCameraProvider cameraProvider;
  private Camera camera;
  private Preview preview;
  private ImageCapture imageCapture;
  private VideoCapture<Recorder> videoCapture;
  private Recording activeRecording;
  private AudioWavRecorder audioRecorder;
  private final AtomicBoolean isCameraRunning = new AtomicBoolean(false);

  private volatile Integer lastIso = null;
  private volatile Long lastExposureTimeNs = null;
  private volatile Integer lastAfState = null;
  private volatile Float lastFocusDistanceDiopters = null;
  private volatile Float lastFocalLengthMm = null;
  private volatile Float minFocusDistanceDiopters = null;
  private volatile String lastVideoPath = null;
  private volatile String lastAudioPath = null;
  private volatile long recordingStartMs = 0;
  private volatile boolean isRecording = false;
  private volatile StopCallback pendingStopCallback = null;

  public interface SimpleCallback { void ok(); void err(String message); }
  public interface CameraStartCallback { void onReady(); void onError(String msg); }
  public interface PhotoCallback { void onPhoto(boolean ok, String path, String err); }
  public interface StopCallback { void onStop(boolean ok, String v, String a, long d, Integer iso, Long exp, String err); }
  public interface FocusCallback { void onFocus(boolean ok, float x, float y, String afState, Float focusDiopters, Double meters, String confidence, String err); }

  public NativeCameraHost(@NonNull Activity activity) {
    this.activity = activity;
    this.mainExecutor = ContextCompat.getMainExecutor(activity);
    sharedInstance = this;
  }

  public void setPreviewView(PreviewView pv) {
    this.previewView = pv;
  }

  public void release() {
    stopCamera();
    previewView = null;
    if (sharedInstance == this) sharedInstance = null;
  }

  public void startPreview(SimpleCallback cb) {
    startCamera(new CameraStartCallback() {
      @Override public void onReady() { if (cb != null) cb.ok(); }
      @Override public void onError(String msg) { if (cb != null) cb.err(msg); }
    });
  }

  public void stopPreview() { stopCamera(); }

  public void startCamera(CameraStartCallback cb) {
    if (isCameraRunning.get() && previewView != null && videoCapture != null && imageCapture != null) {
      if (cb != null) cb.onReady();
      return;
    }
    if (previewView == null) {
      if (cb != null) cb.onError("view_not_ready");
      return;
    }
    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) {
      if (cb != null) cb.onError("camera_permission_denied");
      return;
    }
    ListenableFuture<ProcessCameraProvider> future = ProcessCameraProvider.getInstance(activity);
    future.addListener(() -> {
      try {
        cameraProvider = future.get();
        bindUseCases(cb);
      } catch (Exception e) {
        Log.e(TAG, "ProcessCameraProvider failed", e);
        if (cb != null) cb.onError("provider_fail: " + e.getMessage());
      }
    }, mainExecutor);
  }

  public void stopCamera() {
    try {
      if (activeRecording != null) {
        try { activeRecording.stop(); } catch (Throwable ignored) {}
        activeRecording = null;
      }
      if (audioRecorder != null) {
        try { audioRecorder.stop(); } catch (Throwable ignored) {}
        audioRecorder = null;
      }
      if (cameraProvider != null) cameraProvider.unbindAll();
    } catch (Exception e) {
      Log.w(TAG, "stopCamera error", e);
    } finally {
      camera = null;
      preview = null;
      imageCapture = null;
      videoCapture = null;
      isRecording = false;
      isCameraRunning.set(false);
    }
  }

  private void bindUseCases(CameraStartCallback cb) {
    if (cameraProvider == null || previewView == null) {
      if (cb != null) cb.onError("view_not_ready");
      return;
    }
    if (!(activity instanceof LifecycleOwner)) {
      if (cb != null) cb.onError("lifecycle_error");
      return;
    }
    try {
      cameraProvider.unbindAll();
      CameraSelector selector = CameraSelector.DEFAULT_BACK_CAMERA;

      Preview.Builder previewBuilder = new Preview.Builder();
      new Camera2Interop.Extender<>(previewBuilder).setSessionCaptureCallback(new CameraCaptureSession.CaptureCallback() {
        @Override
        public void onCaptureCompleted(@NonNull android.hardware.camera2.CameraCaptureSession session, @NonNull android.hardware.camera2.CaptureRequest request, @NonNull TotalCaptureResult result) {
          try {
            Integer iso = result.get(CaptureResult.SENSOR_SENSITIVITY);
            Long exp = result.get(CaptureResult.SENSOR_EXPOSURE_TIME);
            Integer af = result.get(CaptureResult.CONTROL_AF_STATE);
            Float fd = result.get(CaptureResult.LENS_FOCUS_DISTANCE);
            Float fl = result.get(CaptureResult.LENS_FOCAL_LENGTH);
            if (iso != null) lastIso = iso;
            if (exp != null) lastExposureTimeNs = exp;
            if (af != null) lastAfState = af;
            if (fd != null) lastFocusDistanceDiopters = fd;
            if (fl != null) lastFocalLengthMm = fl;
          } catch (Throwable ignored) {}
        }
      });
      preview = previewBuilder.build();
      preview.setSurfaceProvider(previewView.getSurfaceProvider());

      imageCapture = new ImageCapture.Builder()
        .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY)
        .build();

      QualitySelector qualitySelector = QualitySelector.from(
        Quality.HD,
        FallbackStrategy.higherQualityOrLowerThan(Quality.HD)
      );
      Recorder recorder = new Recorder.Builder().setQualitySelector(qualitySelector).build();
      videoCapture = VideoCapture.withOutput(recorder);

      camera = cameraProvider.bindToLifecycle((LifecycleOwner) activity, selector, preview, imageCapture, videoCapture);
      try {
        Camera2CameraInfo info = Camera2CameraInfo.from(camera.getCameraInfo());
        Float minFd = info.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_MINIMUM_FOCUS_DISTANCE);
        float[] focalLengths = info.getCameraCharacteristic(CameraCharacteristics.LENS_INFO_AVAILABLE_FOCAL_LENGTHS);
        if (minFd != null) minFocusDistanceDiopters = minFd;
        if (focalLengths != null && focalLengths.length > 0) lastFocalLengthMm = focalLengths[0];
      } catch (Throwable ignored) {}
      isCameraRunning.set(true);
      Log.i(TAG, "Camera bound with preview + photo + video");
      if (cb != null) cb.onReady();
    } catch (Exception e) {
      Log.e(TAG, "bindUseCases error", e);
      if (cb != null) cb.onError("bind_fail: " + e.getMessage());
    }
  }

  public void startRecording(int sampleRate, int channels, SimpleCallback cb) {
    if (ContextCompat.checkSelfPermission(activity, Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
      if (cb != null) cb.err("microphone_permission_denied");
      return;
    }
    if (isRecording) {
      if (cb != null) cb.err("already_recording");
      return;
    }
    long ts = System.currentTimeMillis();
    File videoFile = dataFile("VID_" + ts + ".mp4");
    File audioFile = dataFile("AUD_" + ts + ".wav");

    startCamera(new CameraStartCallback() {
      @Override public void onReady() {
        try {
          AudioWavRecorder.Config cfg = new AudioWavRecorder.Config();
          cfg.sampleRate = sampleRate;
          cfg.channels = channels > 1 ? 2 : 1;
          if (cfg.channels == 2) cfg.channelConfig = android.media.AudioFormat.CHANNEL_IN_STEREO;
          audioRecorder = new AudioWavRecorder(cfg);
          audioRecorder.start(audioFile);

          FileOutputOptions out = new FileOutputOptions.Builder(videoFile).build();
          recordingStartMs = System.currentTimeMillis();
          lastVideoPath = toDataRelative(activity, videoFile.getAbsolutePath());
          lastAudioPath = toDataRelative(activity, audioFile.getAbsolutePath());
          pendingStopCallback = null;

          activeRecording = videoCapture.getOutput()
            .prepareRecording(activity, out)
            .start(mainExecutor, event -> {
              if (event instanceof VideoRecordEvent.Finalize) {
                long duration = Math.max(0, System.currentTimeMillis() - recordingStartMs);
                VideoRecordEvent.Finalize fin = (VideoRecordEvent.Finalize) event;
                StopCallback cb = pendingStopCallback;
                pendingStopCallback = null;
                activeRecording = null;
                isRecording = false;
                if (cb != null) {
                  boolean ok = !fin.hasError();
                  String err = fin.hasError() ? "CameraX finalize error: " + fin.getError() : null;
                  cb.onStop(ok, lastVideoPath, lastAudioPath, duration, lastIso, lastExposureTimeNs, err);
                }
              }
            });
          isRecording = true;
          if (cb != null) cb.ok();
        } catch (Exception e) {
          Log.e(TAG, "startRecording failed", e);
          try { if (audioRecorder != null) audioRecorder.stop(); } catch (Throwable ignored) {}
          audioRecorder = null;
          isRecording = false;
          if (cb != null) cb.err("recording_start_fail: " + e.getMessage());
        }
      }
      @Override public void onError(String msg) { if (cb != null) cb.err(msg); }
    });
  }

  public void stopRecording(StopCallback cb) {
    if (!isRecording && activeRecording == null) {
      cb.onStop(false, null, null, 0, null, null, "not_recording");
      return;
    }
    pendingStopCallback = cb;
    try {
      if (audioRecorder != null) audioRecorder.stop();
    } catch (Throwable ignored) {
    } finally {
      audioRecorder = null;
    }
    if (activeRecording != null) {
      try { activeRecording.stop(); } catch (Throwable t) {
        StopCallback pending = pendingStopCallback;
        pendingStopCallback = null;
        isRecording = false;
        if (pending != null) pending.onStop(false, null, null, 0, null, null, "recording_stop_fail: " + t.getMessage());
      }
    }
  }

  public void takePhoto(String filename, PhotoCallback cb) {
    startCamera(new CameraStartCallback() {
      @Override public void onReady() {
        try {
          String safe = filename;
          if (safe == null || safe.trim().isEmpty()) safe = "IMG_" + System.currentTimeMillis() + ".jpg";
          if (!safe.toLowerCase().endsWith(".jpg") && !safe.toLowerCase().endsWith(".jpeg")) safe += ".jpg";
          File photoFile = dataFile(safe);
          ImageCapture.OutputFileOptions out = new ImageCapture.OutputFileOptions.Builder(photoFile).build();
          imageCapture.takePicture(out, mainExecutor, new ImageCapture.OnImageSavedCallback() {
            @Override public void onImageSaved(@NonNull ImageCapture.OutputFileResults outputFileResults) {
              cb.onPhoto(true, toDataRelative(activity, photoFile.getAbsolutePath()), null);
            }
            @Override public void onError(@NonNull ImageCaptureException exception) {
              cb.onPhoto(false, null, "photo_fail: " + exception.getMessage());
            }
          });
        } catch (Exception e) {
          cb.onPhoto(false, null, "photo_fail: " + e.getMessage());
        }
      }
      @Override public void onError(String msg) { cb.onPhoto(false, null, msg); }
    });
  }

  public void tapToFocus(float normalizedX, float normalizedY, FocusCallback cb) {
    startCamera(new CameraStartCallback() {
      @Override public void onReady() {
        try {
          if (camera == null || previewView == null) {
            if (cb != null) cb.onFocus(false, normalizedX, normalizedY, afStateName(lastAfState), lastFocusDistanceDiopters, estimateMetersFromDiopters(lastFocusDistanceDiopters), "unavailable", "camera_not_ready");
            return;
          }
          float x = Math.max(0f, Math.min(1f, normalizedX));
          float y = Math.max(0f, Math.min(1f, normalizedY));
          MeteringPoint point = previewView.getMeteringPointFactory().createPoint(x * Math.max(1, previewView.getWidth()), y * Math.max(1, previewView.getHeight()));
          FocusMeteringAction action = new FocusMeteringAction.Builder(point, FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE)
            .setAutoCancelDuration(4, TimeUnit.SECONDS)
            .build();
          ListenableFuture<FocusMeteringResult> future = camera.getCameraControl().startFocusAndMetering(action);
          future.addListener(() -> {
            try {
              FocusMeteringResult result = future.get();
              boolean success = result.isFocusSuccessful();
              Double meters = estimateMetersFromDiopters(lastFocusDistanceDiopters);
              String conf = distanceConfidence(success, lastFocusDistanceDiopters, meters);
              if (cb != null) cb.onFocus(true, x, y, success ? "FOCUSED_LOCKED" : afStateName(lastAfState), lastFocusDistanceDiopters, meters, conf, null);
            } catch (Exception e) {
              if (cb != null) cb.onFocus(false, x, y, afStateName(lastAfState), lastFocusDistanceDiopters, estimateMetersFromDiopters(lastFocusDistanceDiopters), "unavailable", "focus_fail: " + e.getMessage());
            }
          }, mainExecutor);
        } catch (Exception e) {
          if (cb != null) cb.onFocus(false, normalizedX, normalizedY, afStateName(lastAfState), lastFocusDistanceDiopters, estimateMetersFromDiopters(lastFocusDistanceDiopters), "unavailable", "focus_fail: " + e.getMessage());
        }
      }
      @Override public void onError(String msg) {
        if (cb != null) cb.onFocus(false, normalizedX, normalizedY, afStateName(lastAfState), lastFocusDistanceDiopters, estimateMetersFromDiopters(lastFocusDistanceDiopters), "unavailable", msg);
      }
    });
  }

  public FocusSnapshot getFocusSnapshot() {
    Double meters = estimateMetersFromDiopters(lastFocusDistanceDiopters);
    return new FocusSnapshot(afStateName(lastAfState), lastFocusDistanceDiopters, meters, distanceConfidence(false, lastFocusDistanceDiopters, meters), lastFocalLengthMm, minFocusDistanceDiopters);
  }

  public static class FocusSnapshot {
    public final String afState;
    public final Float focusDistanceDiopters;
    public final Double estimatedMeters;
    public final String confidence;
    public final Float focalLengthMm;
    public final Float minFocusDistanceDiopters;
    FocusSnapshot(String afState, Float focusDistanceDiopters, Double estimatedMeters, String confidence, Float focalLengthMm, Float minFocusDistanceDiopters) {
      this.afState = afState;
      this.focusDistanceDiopters = focusDistanceDiopters;
      this.estimatedMeters = estimatedMeters;
      this.confidence = confidence;
      this.focalLengthMm = focalLengthMm;
      this.minFocusDistanceDiopters = minFocusDistanceDiopters;
    }
  }

  private static Double estimateMetersFromDiopters(Float diopters) {
    if (diopters == null || diopters <= 0.0001f) return null;
    double meters = 1.0d / diopters;
    if (meters < 0.03d || meters > 1000d) return null;
    return meters;
  }

  private static String distanceConfidence(boolean focusSuccess, Float diopters, Double meters) {
    if (diopters == null || meters == null) return "unavailable";
    if (!focusSuccess) return "low";
    if (meters >= 0.2d && meters <= 20d) return "medium";
    return "low";
  }

  private static String afStateName(Integer state) {
    if (state == null) return "UNKNOWN";
    switch (state) {
      case CaptureResult.CONTROL_AF_STATE_INACTIVE: return "INACTIVE";
      case CaptureResult.CONTROL_AF_STATE_PASSIVE_SCAN: return "PASSIVE_SCAN";
      case CaptureResult.CONTROL_AF_STATE_PASSIVE_FOCUSED: return "PASSIVE_FOCUSED";
      case CaptureResult.CONTROL_AF_STATE_ACTIVE_SCAN: return "ACTIVE_SCAN";
      case CaptureResult.CONTROL_AF_STATE_FOCUSED_LOCKED: return "FOCUSED_LOCKED";
      case CaptureResult.CONTROL_AF_STATE_NOT_FOCUSED_LOCKED: return "NOT_FOCUSED_LOCKED";
      case CaptureResult.CONTROL_AF_STATE_PASSIVE_UNFOCUSED: return "PASSIVE_UNFOCUSED";
      default: return "AF_STATE_" + state;
    }
  }


  public boolean setTorch(boolean enabled) {
    if (camera == null || !camera.getCameraInfo().hasFlashUnit()) return false;
    camera.getCameraControl().enableTorch(enabled);
    return true;
  }

  public boolean setZoom(float ratio) {
    if (camera == null) return false;
    float safe = Math.max(1f, ratio);
    camera.getCameraControl().setZoomRatio(safe);
    return true;
  }

  private File dataFile(String filename) {
    File dir = new File(activity.getFilesDir(), "BusData");
    if (!dir.exists()) dir.mkdirs();
    return new File(dir, filename);
  }

  public static String toDataRelative(Context ctx, String absPath) {
    if (absPath == null) return null;
    String base = ctx.getFilesDir().getAbsolutePath();
    if (absPath.startsWith(base)) {
      String rel = absPath.substring(base.length());
      return rel.startsWith("/") ? rel.substring(1) : rel;
    }
    return absPath;
  }

  public static String buildDeviceString(Context ctx) {
    return Build.MANUFACTURER + " " + Build.MODEL + " (Android " + Build.VERSION.RELEASE + ")";
  }

  public static String basename(String path) {
    if (path == null) return null;
    int i = path.lastIndexOf('/');
    return i >= 0 ? path.substring(i + 1) : path;
  }
}
