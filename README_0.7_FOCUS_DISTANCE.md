# Bus Vision 2.0.0.7 Focus Distance Estimator

## 更新重點

- 移除中央大型固定測距框，避免遮擋畫面與造成「已精準測距」的誤解。
- 點擊畫面任意位置會觸發 CameraX/Camera2 對焦與測光。
- 主畫面即時顯示 AF 狀態、估計距離與距離信心等級。
- metadata 會記錄 tapX/tapY、AF 狀態、focusDistanceDiopters、estimatedMeters、distanceConfidence、鏡頭焦距等資料。
- 資料品質檢查納入「是否有對焦資料」與「是否有距離標籤/估計距離」。

## 測距方案說明

Android 原生層使用 Camera2 的 `LENS_FOCUS_DISTANCE`，單位為 diopter。當手機回傳有效值時，App 會用 `estimatedMeters = 1 / diopter` 做即時距離估計。

這是臨時距離估計與研究 metadata，不是雷射測距儀。不同手機、不同鏡頭、低光、長焦、廣角與自動對焦演算法都會影響準確度。因此 App 會同時保存 `distanceConfidence`：

- `medium`：對焦成功且焦距距離值在合理範圍。
- `low`：有焦距數值但可信度較低。
- `unavailable`：手機未提供焦距距離。

後續若要更準，可加入校正模式：在已知 1m、2m、5m、10m 距離拍攝標定板/公車，建立每支手機與鏡頭的校正曲線。
