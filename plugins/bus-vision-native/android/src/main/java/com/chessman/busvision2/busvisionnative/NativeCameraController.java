package com.chessman.busvision2.busvisionnative;

import android.app.Activity;
import android.hardware.camera2.CaptureRequest;
import android.os.Build;

import androidx.camera.camera2.interop.Camera2Interop;
import androidx.camera.core.Camera;
import androidx.camera.core.CameraSelector;
import androidx.camera.core.FocusMeteringAction;
import androidx.camera.core.ImageCapture;
import androidx.camera.core.MeteringPoint;
import androidx.camera.core.Preview;
import androidx.camera.lifecycle.ProcessCameraProvider;
import androidx.camera.view.PreviewView;
import androidx.core.content.ContextCompat;

import com.google.common.util.concurrent.ListenableFuture;

import java.util.concurrent.Executor;
import java.util.concurrent.TimeUnit;

public class NativeCameraController {
  private final Activity activity;
  private final Executor mainExecutor;
  private PreviewView previewView;

  private ProcessCameraProvider provider;
  private Camera camera;
  private Preview preview;
  private ImageCapture imageCapture;

  private boolean nightEnabled = false;
  private boolean started = false;

  public NativeCameraController(Activity activity) {
    this.activity = activity;
    this.mainExecutor = ContextCompat.getMainExecutor(activity);
  }

  public void attachPreviewView(PreviewView pv) {
    this.previewView = pv;
    if (started) start();
  }

  public void start() {
    started = true;
    if (previewView == null) return;
    ListenableFuture<ProcessCameraProvider> fut = ProcessCameraProvider.getInstance(activity);
    fut.addListener(() -> {
      try {
        provider = fut.get();
        bind();
      } catch (Exception ignored) {
      }
    }, mainExecutor);
  }

  public void stop() {
    started = false;
    if (provider != null) provider.unbindAll();
    provider = null;
    camera = null;
    preview = null;
    imageCapture = null;
  }

  private void bind() {
    if (provider == null || previewView == null) return;

    provider.unbindAll();

    Preview.Builder pb = new Preview.Builder();
    Camera2Interop.Extender<Preview> pInterop = new Camera2Interop.Extender<>(pb);

    if (nightEnabled) {
      pInterop.setCaptureRequestOption(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY);
      pInterop.setCaptureRequestOption(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_HIGH_QUALITY);
      pInterop.setCaptureRequestOption(CaptureRequest.COLOR_CORRECTION_ABERRATION_MODE, CaptureRequest.COLOR_CORRECTION_ABERRATION_MODE_HIGH_QUALITY);
      if (Build.VERSION.SDK_INT >= 28) {
        pInterop.setCaptureRequestOption(CaptureRequest.CONTROL_ENABLE_ZSL, true);
      }
    } else {
      pInterop.setCaptureRequestOption(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_FAST);
      pInterop.setCaptureRequestOption(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_FAST);
    }

    preview = pb.build();
    preview.setSurfaceProvider(previewView.getSurfaceProvider());

    ImageCapture.Builder icb = new ImageCapture.Builder()
      .setCaptureMode(ImageCapture.CAPTURE_MODE_MINIMIZE_LATENCY);

    Camera2Interop.Extender<ImageCapture> icInterop = new Camera2Interop.Extender<>(icb);
    if (nightEnabled) {
      icInterop.setCaptureRequestOption(CaptureRequest.NOISE_REDUCTION_MODE, CaptureRequest.NOISE_REDUCTION_MODE_HIGH_QUALITY);
      icInterop.setCaptureRequestOption(CaptureRequest.EDGE_MODE, CaptureRequest.EDGE_MODE_HIGH_QUALITY);
      icInterop.setCaptureRequestOption(CaptureRequest.COLOR_CORRECTION_ABERRATION_MODE, CaptureRequest.COLOR_CORRECTION_ABERRATION_MODE_HIGH_QUALITY);
    }

    imageCapture = icb.build();

    CameraSelector selector = new CameraSelector.Builder()
      .requireLensFacing(CameraSelector.LENS_FACING_BACK)
      .build();

    camera = provider.bindToLifecycle((androidx.lifecycle.LifecycleOwner) activity, selector, preview, imageCapture);
  }

  public boolean tapToFocus(float xNorm, float yNorm) {
    if (camera == null || previewView == null) return false;
    float x = clamp01(xNorm);
    float y = clamp01(yNorm);

    MeteringPoint point = previewView.getMeteringPointFactory().createPoint(
      x * previewView.getWidth(),
      y * previewView.getHeight()
    );

    FocusMeteringAction action = new FocusMeteringAction.Builder(
      point,
      FocusMeteringAction.FLAG_AF | FocusMeteringAction.FLAG_AE | FocusMeteringAction.FLAG_AWB
    ).setAutoCancelDuration(2, TimeUnit.SECONDS).build();

    camera.getCameraControl().startFocusAndMetering(action);
    return true;
  }

  public boolean setZoom(float zoom) {
    if (camera == null) return false;
    float minZoom = 1f;
    float maxZoom = 10f;
    try {
      androidx.camera.core.ZoomState zs = camera.getCameraInfo().getZoomState().getValue();
      if (zs != null) {
        minZoom = zs.getMinZoomRatio();
        maxZoom = zs.getMaxZoomRatio();
      }
    } catch (Throwable ignored) {}
    float target = Math.max(minZoom, Math.min(maxZoom, zoom));
    camera.getCameraControl().setZoomRatio(target);
    return true;
  }

  public boolean setTorch(boolean enabled) {
    if (camera == null) return false;
    camera.getCameraControl().enableTorch(enabled);
    return true;
  }

  public void setNightEnabled(boolean enabled) {
    nightEnabled = enabled;
    if (provider != null) bind();
  }

  private float clamp01(float v) {
    if (v < 0f) return 0f;
    if (v > 1f) return 1f;
    return v;
  }
}
