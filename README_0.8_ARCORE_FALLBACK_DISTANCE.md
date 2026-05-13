# Bus Vision 2.0.0.8 — ARCore 優先測距 / Fallback 版

本版將距離估計管線改成三層 fallback：

1. **ARCore Depth**：優先檢查裝置是否有 Google Play Services for AR / ARCore 能力。
2. **Camera2 focusDistance**：若 ARCore Depth 沒有可用的 depth frame，改用 Camera2 `LENS_FOCUS_DISTANCE` 估算距離。
3. **手動距離標籤**：若手機不回傳對焦距離，仍保存近 / 中 / 遠 / 未知等人工距離標籤。

> 注意：目前 App 主相機管線仍是 CameraX。真正 ARCore Depth frame 需要 ARCore Session 接管相機，因此本版先完成「ARCore 優先偵測與 fallback 資料結構」。若 ARCore depth session 尚未啟動，App 會自動降級，不會阻塞採集。

## 新增 metadata

每筆資料會新增或更新：

```json
{
  "telemetry": {
    "focusDistance": {
      "finalDistanceMeters": 8.2,
      "distanceSource": "focus_distance",
      "distancePipeline": ["arcore_depth", "focus_distance", "manual_label"],
      "arcore": {
        "installed": true,
        "available": true,
        "depthSupported": false,
        "status": "arcore_installed_but_depth_session_not_active"
      }
    },
    "objectDistance": {
      "mode": "arcore-focus-manual-fallback",
      "source": "focus_distance",
      "value": 8.2,
      "confidence": "medium"
    }
  },
  "focusEvent": {
    "distanceSource": "focus_distance",
    "finalDistanceMeters": 8.2,
    "manualDistanceLabel": "middle"
  }
}
```

## UI 更新

主畫面會顯示：

- AF 狀態
- 距離估計
- 距離來源：ARCore Depth / 對焦距離 / 手動標籤 / 無資料
- 信心等級

## 後續可延伸

若要真正使用 ARCore Depth 即時深度，需要新增 ARCore Session / Frame / HitResult 管線，並在 AR 模式下暫停 CameraX preview，或建立獨立的 AR 測距頁。這會是 0.9 的自然下一步。
