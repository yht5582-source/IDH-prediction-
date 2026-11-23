# HD-AI｜透析中低血壓預警（IDH Prediction）

獨立 GitHub 儲存庫，含 `index.html` 手機與桌面互動展示介面（v0.6）。

- 依病人 ID 追蹤 CAN 與既往 IDH，依每次 Session ID 記錄血壓與 UF。
- 同一床位可在不同日期／班別分配不同病人。
- 週一三五三班（第三班＝夜班），週二四六兩班；非排程透析另用 X 時段。
- 常規、臨時加做、緊急與住院間歇 HD 以療程類型區分。
- 常規每小時測量血壓，異常時加測。
- 支援合成病例、規則警示、CAN 記錄及護理確認流程。

**注意：僅供教學測試。** 未使用院內實際資料，也未訓練 XGBoost；這不是臨床可使用的 AI 預測模型。此儲存庫為公開網站，請勿輸入真實病人識別資訊或任何臨床資料。

## GitHub Pages 啟用

Repository **Settings → Pages → Build and deployment → Deploy from a branch → main / (root) → Save**。

預期網址：https://yht5582-source.github.io/IDH-prediction-/

來源原型：`yht5582-source/hemodialysis-ktv-calculator/hd-ai/`。為避免破壞原 Kt/V 網站，目前保留舊版程式碼；新功能請改在本儲存庫開發。
