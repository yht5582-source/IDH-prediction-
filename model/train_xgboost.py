#!/usr/bin/env python3
"""HD-AI research pipeline: one landmark per available blood-pressure measurement.

Inputs contain ONLY de-identified data. Use on an approved hospital machine.
NO model trained here is approved for patient care.
"""
import argparse
import json
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss
from sklearn.isotonic import IsotonicRegression
from xgboost import XGBClassifier

FEATURES = [
    "sbp", "dbp", "hr", "ufr_kg_h", "elapsed_min",
    "sbp_delta_previous", "minutes_since_previous",
    "idh_last10_routine", "idh_last10_all",
    "can_confirmed", "can_suspected",
]
REQUIRED_SESSIONS = {
    "patient_id", "session_id", "start_at", "end_at", "session_type",
    "idh_last10_routine", "idh_last10_all", "can_status"
}
REQUIRED_VITALS = {
    "session_id", "measured_at", "sbp", "dbp", "hr", "ufr_kg_h"
}

def load_and_check(sessions_path, vitals_path):
    sessions = pd.read_csv(sessions_path, dtype={"patient_id": str, "session_id": str})
    vitals = pd.read_csv(vitals_path, dtype={"session_id": str})
    for name, df, required in [
        ("sessions", sessions, REQUIRED_SESSIONS),
        ("vitals", vitals, REQUIRED_VITALS)
    ]:
        missing = required - set(df.columns)
        if missing:
            raise ValueError("%s missing columns: %s" % (name, sorted(missing)))
    if sessions.session_id.isna().any() or sessions.session_id.duplicated().any():
        raise ValueError("session_id must be present and unique in sessions.csv")
    for col in ["start_at", "end_at"]:
        sessions[col] = pd.to_datetime(sessions[col], errors="coerce")
    vitals["measured_at"] = pd.to_datetime(vitals["measured_at"], errors="coerce")
    if sessions[["start_at", "end_at"]].isna().any().any() or vitals.measured_at.isna().any():
        raise ValueError("Invalid timestamp: use YYYY-MM-DD HH:MM:SS")
    if (sessions.end_at <= sessions.start_at).any():
        raise ValueError("end_at must be later than start_at")
    for col in ["sbp", "dbp", "hr", "ufr_kg_h"]:
        vitals[col] = pd.to_numeric(vitals[col], errors="coerce")
    valid = (
        vitals.sbp.between(40, 280) &
        vitals.dbp.between(20, 180) &
        (vitals.dbp < vitals.sbp) &
        vitals.hr.between(20, 220) &
        vitals.ufr_kg_h.between(0, 30)
    )
    if not valid.all():
        raise ValueError("Invalid BP, HR or UFR rows: %d" % (~valid).sum())
    if vitals.duplicated(["session_id", "measured_at"]).any():
        raise ValueError("Duplicated session_id + measured_at")
    if (~vitals.session_id.isin(sessions.session_id)).any():
        raise ValueError("Orphan vitals session_id")
    merged = vitals.merge(sessions, on="session_id", validate="many_to_one")
    if ((merged.measured_at < merged.start_at) |
        (merged.measured_at > merged.end_at)).any():
        raise ValueError("Measurements outside session start/end")
    return sessions, merged.sort_values(["session_id", "measured_at"]).reset_index(drop=True)

def make_landmarks(sessions, merged, horizon_minutes=60):
    """Label a landmark only if the next full horizon is observable.
    
    Outcome = first *recorded* SBP<90 in (t,t+60m]. An absence of
    measurements does not prove physiologic absence of IDH.
    Pre-existing IDH (SBP<90 at or before t) excluded from first-event risk.
    """
    rows = []
    for sid, group in merged.groupby("session_id", sort=False):
        g = group.sort_values("measured_at").reset_index(drop=True)
        s = g.iloc[0]
        if s.session_type != "routine":
            continue  # non-routine sessions are retained in source, NOT trained
        history_idh = False
        for i, r in g.iterrows():
            if r.sbp < 90:
                history_idh = True
            if history_idh:
                continue
            t = r.measured_at
            horizon_end = t + pd.Timedelta(minutes=horizon_minutes)
            if horizon_end > r.end_at:
                continue  # no full observation window
            future = g[(g.measured_at > t) & (g.measured_at <= horizon_end)]
            # Measured BP at a future time is required; otherwise the
            # interval is not labelled as negative based on silence.
            if future.empty:
                continue
            # Require a documented future measurement at/near horizon end.
            # This is an operational label, not continuous hemodynamic truth.
            last_future_time = future.measured_at.max()
            if (horizon_end - last_future_time).total_seconds() > 15 * 60:
                continue
            prev = g.iloc[i - 1] if i else None
            delta = float(r.sbp - prev.sbp) if prev is not None else np.nan
            lag = (t - prev.measured_at).total_seconds() / 60 if prev is not None else np.nan
            can = str(r.can_status).lower().strip()
            rows.append({
                "patient_id": r.patient_id, "session_id": sid,
                "session_start": r.start_at, "measured_at": t,
                "sbp": r.sbp, "dbp": r.dbp, "hr": r.hr,
                "ufr_kg_h": r.ufr_kg_h,
                "elapsed_min": (t - r.start_at).total_seconds() / 60,
                "sbp_delta_previous": delta, "minutes_since_previous": lag,
                "idh_last10_routine": r.idh_last10_routine,
                "idh_last10_all": r.idh_last10_all,
                "can_confirmed": int(can in ["confirmed", "確診"]),
                "can_suspected": int(can in ["suspected", "疑似"]),
                "idh_next_60min": int((future.sbp < 90).any()),
            })
    if not rows:
        raise ValueError("No eligible routine landmarks; check follow-up and observation windows")
    result = pd.DataFrame(rows).sort_values(["session_start", "measured_at"])
    for col in FEATURES + ["idh_next_60min"]:
        result[col] = pd.to_numeric(result[col], errors="coerce")
    if result[["patient_id", "session_id"]].isna().any().any():
        raise ValueError("Missing patient/session identifiers")
    return result

def split_by_session_date(df):
    """Temporal split by entire session dates; no session crosses a split."""
    unique_days = sorted(df.session_start.dt.normalize().unique())
    if len(unique_days) < 15:
        raise ValueError("Need at least 15 distinct session dates for temporal holdout")
    d1 = unique_days[int(len(unique_days) * 0.70)]
    d2 = unique_days[int(len(unique_days) * 0.85)]
    dates = df.session_start.dt.normalize()
    parts = (df[dates < d1], df[(dates >= d1) & (dates < d2)], df[dates >= d2])
    if min(len(p) for p in parts) == 0:
        raise ValueError("Empty temporal partition")
    return parts

def scores(y, p):
    if len(np.unique(y)) != 2:
        raise ValueError("Holdout needs positive and negative outcomes")
    return {
        "auroc": float(roc_auc_score(y, p)),
        "auprc": float(average_precision_score(y, p)),
        "brier": float(brier_score_loss(y, p)),
        "prevalence": float(np.mean(y)),
        "landmarks": len(y),
        "positive_landmarks": int(np.sum(y)),
    }

def train(args):
    sessions, merged = load_and_check(args.sessions, args.vitals)
    df = make_landmarks(sessions, merged)
    train_df, valid_df, test_df = split_by_session_date(df)
    for name, part in [("train", train_df), ("validation", valid_df), ("test", test_df)]:
        if part.idh_next_60min.nunique() != 2:
            raise ValueError("%s contains only one outcome class" % name)
    Xtr, ytr = train_df[FEATURES], train_df.idh_next_60min
    Xva, yva = valid_df[FEATURES], valid_df.idh_next_60min
    Xte, yte = test_df[FEATURES], test_df.idh_next_60min
    model = XGBClassifier(
        n_estimators=450, max_depth=3, learning_rate=0.03,
        subsample=0.8, colsample_bytree=0.8,
        objective="binary:logistic", eval_metric="logloss",
        tree_method="hist", early_stopping_rounds=30,
        random_state=42, n_jobs=4
    )
    model.fit(Xtr, ytr, eval_set=[(Xva, yva)], verbose=False)
    raw_valid = model.predict_proba(Xva)[:, 1]
    raw_test = model.predict_proba(Xte)[:, 1]
    # Validation-only isotonic calibration; do NOT calibrate on test.
    calibrator = IsotonicRegression(out_of_bounds="clip")
    calibrator.fit(raw_valid, yva)
    calibrated_test = calibrator.predict(raw_test)
    report = {
        "intended_use": "research only; recorded first IDH in next 60min",
        "routine_only": True, "feature_names": FEATURES,
        "train_count": len(train_df), "validation_count": len(valid_df),
        "test_count": len(test_df),
        "raw_validation": scores(yva, raw_valid),
        "raw_test": scores(yte, raw_test),
        "calibrated_test": scores(yte, calibrated_test),
        "warning": "Synthetic results are NOT clinical performance; external and prospective validation required."
    }
    dest = Path(args.output)
    dest.mkdir(parents=True, exist_ok=True)
    model.save_model(str(dest / "idh_xgboost.json"))
    # Isotonic mapping portable without pickle execution.
    mapping = {"x_thresholds": calibrator.X_thresholds_.tolist(),
               "y_thresholds": calibrator.y_thresholds_.tolist()}
    (dest / "calibration.json").write_text(json.dumps(mapping, indent=2), encoding="utf-8")
    (dest / "metrics.json").write_text(json.dumps(report, indent=2, ensure_ascii=False), encoding="utf-8")
    # Labels/features are sensitive even without names: do not commit output directory.
    print(json.dumps(report, indent=2, ensure_ascii=False))

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--sessions", required=True)
    parser.add_argument("--vitals", required=True)
    parser.add_argument("--output", default="local_model_outputs")
    train(parser.parse_args())
