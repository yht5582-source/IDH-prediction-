# HD-AI｜透析中低血壓預警系統 v0.7

[互動網頁（GitHub Pages）](https://yht5582-source.github.io/IDH-prediction-/)

目前具有 60 床總覽、病人與每次療程獨立識別、常規/緊急透析管理、CAN 風險紀錄、常規每小時與異常加測血壓、規則型提醒。**本網站使用合成資料，非已驗證 AI 模型，禁止輸入真實病人資料。**

## XGBoost v0.7 建模

新增 `ml/train.py`、`ml/requirements.txt`、`ml/test_train.py`，以研究工作站或院內核准環境執行。靜態 GitHub Pages **不能自行執行 Python/XGBoost 模型**；尚未部署臨床推論 API。

### 1. 安裝與合成測試

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r ml/requirements.txt
python ml/train.py synthetic --out demo
python -m unittest discover -s ml -p 'test_*.py'
python ml/train.py train --sessions demo/sessions.csv --vitals demo/vitals.csv --out demo/output
```

Windows 啟用虛擬環境請改用 `.venv\Scripts\activate`。模型 JSON、校準參數、特徵清單與 metrics JSON 儲存在 `demo/output/`。所有合成資料與衍生成績只能用作流程驗證；不能推論臨床模型效能。若某個時間切分沒有陽性事件，訓練程式會停止，而不虛構結果。

### 2. 院內資料格式

`sessions.csv`（**每次透析一列**）：
```text
patient_id,session_id,session_start,session_end,session_type,pre_sbp,idh_prev10_routine,idh_prev10_all,can_status,dm
```

`vitals.csv`（**每次血壓量測一列**）：
```text
session_id,measured_at,sbp,dbp,hr,ufr_kg_h
```

- 時間戳記採完整本地日期時間（例如 `2026-11-23T10:00:00+08:00`，且整批需一致），不可只有 10:00。
- `session_type`：`routine`、`extra`、`urgent`、`inpatient`；第一版只以 `routine` 訓練。
- `can_status`：`confirmed`、`suspected`、`unknown`、`no_evidence`；糖尿病不能當作已確診 CAN。
- `idh_prev10_routine`、`idh_prev10_all`：**必須只用預測時間點之前已知的歷史療程**計算，不得從全部資料事後回填。
- 不以床號作為預測特徵；病人跨床位透析由 Patient ID 追蹤，單次療程血壓由 Session ID 連結。
- 常規一小時 BP，異常時不規則加測，保留測量及事件原始時間戳記。
- 最好另外提供加測原因、處置與其時間、UF 調整時間、療程結束原因、實際資料寫入時間、病人是否症狀性低血壓，以支援後續嚴格驗證。

### 3. 研究標籤及評估

只對當下 SBP ≥90、尚未發生 IDH 的療程量測時間點建模。標籤為**接下來 60 分鐘內首次「有紀錄」SBP <90 mmHg**。不足 60 分鐘觀察期者排除，已發生第一次低血壓後的時間點不作為新發事件。若提前處置或提前終止造成標籤不可判定，正式研究應另行處理 censoring/competing events。

依日期與療程作時間外切分（訓練／驗證／測試），使用驗證資料擬合機率校準、僅在測試資料評估。輸出 AUROC、AUPRC、Brier 分數、測試療程數與人數。**仍需補充病人群聚 bootstrap、病人外部驗證、IDH 事件層級敏感度、預警提前時間、模型校準曲線與預警負擔**，才能評估是否值得臨床試行。

### 4. 資安及臨床限制

請勿將院內病人資料、輸出的真實模型與內部報表提交公開 GitHub。院內推論 API 應具有身份驗證、授權與稽核。所有臨床預警均依院內 SOP；XGBoost 或本示範網頁不能直接控制 UF、藥物或輸液。模型完成後還須由院內 IRB、資安、臨床品質及醫療器材法規單位評估。

## 排班與床位架構

- 週一／三／五：第一、第二、第三班（第三班就是夜班）。
- 週二／四／六：第一、第二班。
- 週日預設無常規透析；緊急或臨時透析使用非排程時段。
- 同一床在不同班別可安排不同病人；以 Patient ID、Session ID、實際日期時間建立關聯。
- 急性非排程透析納入病人歷史及獨立資料集，**不可未經驗證直接套用常規 XGBoost 模型**。

## v0.7 驗證狀態

已透過 GitHub API 上傳並重新擷取確認程式檔案；因目前執行環境不能連線至 GitHub raw 網址，**尚未完成本機 XGBoost 實際訓練與單元測試執行**。目前為研究管線程式，不得宣稱模型訓練成功。
