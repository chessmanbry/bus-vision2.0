package com.chessman.busvision2;

import android.graphics.Color;
import android.os.Bundle;
import android.view.View;
import android.view.ViewGroup;
import android.webkit.WebView;
import android.widget.FrameLayout;

import androidx.annotation.Nullable;
import androidx.camera.view.PreviewView;

import com.getcapacitor.Bridge;
import com.getcapacitor.BridgeActivity;
import com.chessman.busvision2.busvisionnative.NativeCameraHost;

public class MainActivity extends BridgeActivity {

  private PreviewView previewView;
  private FrameLayout root;
  private NativeCameraHost host;

  @Override
  protected void onCreate(@Nullable Bundle savedInstanceState) {
    super.onCreate(savedInstanceState);

    // 固定 Android 系統導覽列為不透明黑色，避免 WebView 內容被三鍵導覽列覆蓋。
    getWindow().setNavigationBarColor(Color.BLACK);
    getWindow().setStatusBarColor(Color.BLACK);

    Bridge bridge = getBridge();

    root = new FrameLayout(this);
    root.setLayoutParams(new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    root.setBackgroundColor(Color.TRANSPARENT);

    // 1. Camera preview (底層)
    previewView = new PreviewView(this);
    previewView.setLayoutParams(new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    // 使用 COMPATIBLE 模式確保在各種 Android 版本上都能正常透明疊加
    previewView.setImplementationMode(PreviewView.ImplementationMode.COMPATIBLE);

    // 2. WebView (上層，透明)
    View webView = bridge.getWebView();
    webView.setLayoutParams(new FrameLayout.LayoutParams(
      ViewGroup.LayoutParams.MATCH_PARENT,
      ViewGroup.LayoutParams.MATCH_PARENT
    ));
    
    // 強制 WebView 背景透明
    webView.setBackgroundColor(Color.TRANSPARENT);
    if (webView instanceof WebView) {
        ((WebView) webView).setLayerType(View.LAYER_TYPE_HARDWARE, null);
    }

    // 移除可能存在的舊 Parent 並重新組合
    ViewGroup parent = (ViewGroup) webView.getParent();
    if (parent != null) parent.removeView(webView);

    root.addView(previewView);
    root.addView(webView);

    setContentView(root);
    
    host = new NativeCameraHost(this);
    host.setPreviewView(previewView);
  }

  @Override
  public void onDestroy() {
    if (host != null) host.release();
    super.onDestroy();
  }

  @Override
  public void onResume() {
    super.onResume();
    // Camera is started explicitly from Recorder after permissions are granted.
  }

  @Override
  public void onPause() {
    if (host != null) host.stopCamera();
    super.onPause();
  }

  public PreviewView getNativePreviewView() {
    return previewView;
  }

  // --- 新增：讓 Plugin 可以取得 NativeCameraHost 實例來操作相機 ---
  public NativeCameraHost getNativeCameraHost() {
    return host;
  }
}
