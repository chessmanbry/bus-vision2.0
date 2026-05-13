# BusVision 2.0.0.8.7 — 夜間曝光與閃光修正版

本版重點：把「補光燈」與「拍照閃光」分離，並加入夜間抗眩光 / OCR 優先曝光控制。

## 更新內容

- 補光燈 Torch：長亮，用於錄影與近距離補光。
- 拍照閃光 Flash：接 CameraX ImageCapture flash mode，支援 auto / on / off。
- 夜間曝光模式：
  - 自動曝光：EV 0
  - 夜間：EV -1
  - 抗車燈：EV -2
  - OCR 優先：EV -3
- 點擊畫面仍會同時做 AF / AE metering，適合點路線牌、LED、車頭區域。
- 抗車燈與 OCR 優先會自動關閉長亮補光，避免反光干擾。
- metadata 新增 lightingControl，記錄 torch、photoFlashMode、exposureMode、exposureCompensation、AE/AF 策略。

## 注意

- EV 補償是否有效取決於手機 CameraX / Camera2 支援狀況。
- 這不是 HDR 合成，而是更適合資料採集的曝光策略記錄。
