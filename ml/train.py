#!/usr/bin/env python3
"""HD-AI v0.7: research-only XGBoost pipeline. No clinical deployment."""
from __future__ import annotations
import argparse
import json
from pathlib import Path
import numpy as np
import pandas as pd

FEATURES = [
    "sbp", "dbp", "hr", "pre_sbp", "delta_sbp",
    "minutes_since_bp", "elapsed_min", "ufr_kg_h",
    "idh_prev10_routine", "idh_prev10_all", "can_confirmed",
    "can_suspected", "dm", "session_hour",
]
REQUIRED_SESSION = [
    "patient_id", "session_id", "session_start", "session_end",
    "session_type", "pre_sbp", "idh_prev10_routine",
    "idh_prev10_all", "can_status", "dm",
]
REQUIRED_VITAL = [
    "session_id", "measured_at", "sbp", "dbp", "hr", "ufr_kg_h",
]
TYPES = ("routine", "extra", "urgent", "inpatient")

def check_columns(frame, required, name):
    missing = set(required) - set(frame.columns)
    if missing:
        raise ValueError(f"{name} missing required columns: {sorted(missing)}")

def load_data(session_file, vital_file):
    sessions = pd.read_csv(session_file, dtype={"patient_id": str, "session_id": str})
    vitals = pd.read_csv(vital_file, dtype={"session_id": str})
    check_columns(sessions, REQUIRED_SESSION, "sessions")
    check_columns(vitals, REQUIRED_VITAL, "vitals")
    if sessions.session_id.isna().any() or sessions.session_id.duplicated().any():
        raise ValueError("session_id must be populated and unique in sessions")
    if vitals.session_id.isna().any():
        raise ValueError("vitals session_id must not be empty")
    if (~vitals.session_id.isin(sessions.session_id)).any():
        raise ValueError("Unmatched vital session_id")
    if (~sessions.session_type.isin(TYPES)).any():
        raise ValueError("Unknown session_type")
    for column in ("session_start", "session_end"):
        sessions[column] = pd.to_datetime(sessions[column], errors="raise")
    vitals["measured_at"] = pd.to_datetime(vitals["measured_at"], errors="raise")
    if sessions[["session_start", "session_end"]].isna().any().any():
        raise ValueError("Missing session timestamps")
    if (sessions.session_end <= sessions.session_start).any():
        raise ValueError("Each session must have end > start")
    numeric_session = ["pre_sbp", "idh_prev10_routine", "idh_prev10_all", "dm"]
    numeric_vital = ["sbp", "dbp", "hr", "ufr_kg_h"]
    for c in numeric_session:
        sessions[c] = pd.to_numeric(sessions[c], errors="coerce")
    for c in numeric_vital:
        vitals[c] = pd.to_numeric(vitals[c], errors="coerce")
    if vitals[["sbp", "dbp", "hr"]].isna().any().any():
        raise ValueError("Missing blood pressure or HR")
    if ((vitals.sbp < 40) | (vitals.sbp > 280) |
        (vitals.dbp < 20) | (vitals.dbp >= vitals.sbp) |
        (vitals.hr < 20) | (vitals.hr > 220) |
        (vitals.ufr_kg_h < 0) | (vitals.ufr_kg_h > 30)).any():
        raise ValueError("Invalid vital signs or UFR")
    merged = vitals.merge(sessions, on="session_id", how="left", validate="many_to_one")
    if ((merged.measured_at < merged.session_start) |
        (merged.measured_at > merged.session_end)).any():
        raise ValueError("Vital timestamp outside session")
    if merged.duplicated(["session_id", "measured_at"]).any():
        raise ValueError("Duplicate session_id + measured_at")
    return sessions, merged.sort_values(["session_id", "measured_at"])

def make_features(merged, horizon_min=60):
    """Predict first *documented* SBP<90 within (t,t+60], from at-risk rows.
    A row must have the entire future horizon observed in that session.
    This excludes sessions that end earlier and avoids treating them as negatives.
    Clinical interventions and measurement-informativeness require separate audit.
    """
    out = []
    for session_id, g in merged.groupby("session_id", sort=False):
        g = g.sort_values("measured_at").copy()
        if g.empty:
            continue
        # Once low BP appears, subsequent measurements are not new onset.
        low = g.loc[g.sbp < 90, "measured_at"]
        first_low = low.iloc[0] if len(low) else None
        previous = None
        for r in g.itertuples(index=False):
            t = r.measured_at
            if first_low is not None and t >= first_low:
                break
            if r.sbp < 90:
                break
            horizon = t + pd.Timedelta(minutes=horizon_min)
            if horizon > r.session_end:
                previous = r
                continue
            # Documented events only; unmeasured episodes remain unobserved.
            label = int(first_low is not None and t < first_low <= horizon)
            diff = float(r.sbp - previous.sbp) if previous is not None else float(r.sbp - r.pre_sbp)
            gap = float((t - previous.measured_at).total_seconds()/60) if previous is not None else np.nan
            out.append(dict(
                patient_id=r.patient_id, session_id=session_id,
                prediction_at=t, session_start=r.session_start,
                session_type=r.session_type,
                sbp=float(r.sbp), dbp=float(r.dbp), hr=float(r.hr),
                pre_sbp=float(r.pre_sbp), delta_sbp=diff,
                minutes_since_bp=gap,
                elapsed_min=float((t-r.session_start).total_seconds()/60),
                ufr_kg_h=float(r.ufr_kg_h),
                idh_prev10_routine=float(r.idh_prev10_routine),
                idh_prev10_all=float(r.idh_prev10_all),
                can_confirmed=int(r.can_status=="confirmed"),
                can_suspected=int(r.can_status=="suspected"),
                dm=float(r.dm), session_hour=int(t.hour),
                idh_next_60min=label,
            ))
            previous = r
    return pd.DataFrame(out)

def split_temporal(df):
    """Chronological disjoint session groups + 60-minute embargo at cutoffs."""
    dates = df[["session_id", "session_start"]].drop_duplicates().sort_values("session_start")
    n = len(dates)
    if n < 30:
        raise ValueError("At least 30 distinct sessions needed for example split")
    cut1 = dates.iloc[int(n*.70)].session_start
    cut2 = dates.iloc[int(n*.85)].session_start
    embargo = pd.Timedelta(minutes=60)
    a = df[df.session_start < cut1-embargo]
    b = df[(df.session_start >= cut1) & (df.session_start < cut2-embargo)]
    c = df[df.session_start >= cut2]
    return a.copy(), b.copy(), c.copy()

def evaluate(y, p):
    from sklearn.metrics import roc_auc_score, average_precision_score, brier_score_loss
    return {
        "n_rows": int(len(y)), "positive_rows": int(np.sum(y)),
        "prevalence": float(np.mean(y)),
        "auroc": float(roc_auc_score(y, p)),
        "auprc": float(average_precision_score(y, p)),
        "brier": float(brier_score_loss(y, p)),
    }

def train(sessions, vitals, outdir):
    from xgboost import XGBClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.metrics import log_loss
    outdir = Path(outdir)
    outdir.mkdir(parents=True, exist_ok=True)
    sess, measurements = load_data(sessions, vitals)
    frame = make_features(measurements)
    if frame.empty:
        raise ValueError("No eligible 60-minute prediction windows; inspect sampling")
    # Urgent, extra and inpatient sessions retained in source files,
    # but excluded from this first routine-only model.
    routine = frame[frame.session_type == "routine"].copy()
    train_df, valid_df, test_df = split_temporal(routine)
    for name, sub in (("train",train_df),("validation",valid_df),("test",test_df)):
        if sub.empty or sub.idh_next_60min.nunique()!=2:
            raise ValueError(f"{name} has no examples of both outcomes; cannot train/evaluate")
    model = XGBClassifier(
        n_estimators=400, max_depth=3, learning_rate=.04,
        subsample=.8, colsample_bytree=.85,
        objective="binary:logistic", eval_metric="logloss",
        tree_method="hist", random_state=42, n_jobs=4,
        early_stopping_rounds=25
    )
    model.fit(train_df[FEATURES], train_df.idh_next_60min,
              eval_set=[(valid_df[FEATURES], valid_df.idh_next_60min)],
              verbose=False)
    # Calibrate only on held-out validation predictions. Do not fit on test.
    raw_valid = model.predict_proba(valid_df[FEATURES])[:,1]
    calibrator = LogisticRegression(random_state=42)
    calibrator.fit(raw_valid.reshape(-1,1), valid_df.idh_next_60min)
    raw_test = model.predict_proba(test_df[FEATURES])[:,1]
    prob = calibrator.predict_proba(raw_test.reshape(-1,1))[:,1]
    metrics = evaluate(test_df.idh_next_60min.to_numpy(), prob)
    metrics.update({
        "scope":"routine-only", "horizon_minutes":60,
        "endpoint":"documented first SBP<90 within next 60 minutes",
        "training_rows":int(len(train_df)),
        "validation_rows":int(len(valid_df)),
        "test_sessions":int(test_df.session_id.nunique()),
        "test_patients":int(test_df.patient_id.nunique()),
        "caution":"Research-only. No external validation or clinical use.",
    })
    model.save_model(str(outdir/"xgboost_idh.json"))
    (outdir/"calibration.json").write_text(json.dumps({
        "coef":float(calibrator.coef_[0][0]),
        "intercept":float(calibrator.intercept_[0])
    },indent=2),encoding="utf-8")
    (outdir/"metrics.json").write_text(json.dumps(metrics,indent=2),encoding="utf-8")
    (outdir/"features.json").write_text(json.dumps(FEATURES,indent=2),encoding="utf-8")
    print(json.dumps(metrics,ensure_ascii=False,indent=2))
    return metrics

def synthetic(outdir, days=180, n_patients=85, seed=7):
    """Synthetic fixtures only; NOT realistic data or clinical efficacy evidence."""
    rng=np.random.default_rng(seed)
    outdir=Path(outdir);outdir.mkdir(parents=True,exist_ok=True)
    ss=[];vs=[];base=pd.Timestamp("2025-01-01 07:30:00")
    for day in range(days):
        d=base+pd.Timedelta(days=day)
        for p in range(n_patients):
            if (day+p)%3: continue
            ident=f"P{p+1:04d}"
            sid=f"S{day:04d}_{p:04d}"
            hour=7+(p%3)*5
            start=d.normalize()+pd.Timedelta(hours=hour,minutes=30)
            end=start+pd.Timedelta(hours=4)
            can="confirmed" if p%11==0 else ("suspected" if p%7==0 else "unknown")
            typ="urgent" if (day+p)%97==0 else "routine"
            prev=int(p%5)
            base_bp=int(145+rng.normal(0,15))
            ss.append(dict(patient_id=ident,session_id=sid,
                session_start=start.isoformat(),session_end=end.isoformat(),
                session_type=typ,pre_sbp=base_bp,
                idh_prev10_routine=prev,idh_prev10_all=prev,
                can_status=can,dm=int(p%3==0)))
            ufr=float(np.clip(6+(p%7)+rng.normal(0,1),1,18))
            decline=float(rng.uniform(4,20)+(8 if p%5==0 else 0))
            for minute in [0,60,120,180,240]:
                sbp=float(np.clip(base_bp-decline*(minute/60)+rng.normal(0,6),55,220))
                vs.append(dict(session_id=sid,measured_at=(start+pd.Timedelta(minutes=minute)).isoformat(),
                    sbp=round(sbp,1),dbp=round(max(30,sbp*.58),1),
                    hr=int(np.clip(74+minute//60*3+rng.normal(0,4),35,160)),
                    ufr_kg_h=round(ufr,1)))
    pd.DataFrame(ss).to_csv(outdir/"sessions.csv",index=False)
    pd.DataFrame(vs).to_csv(outdir/"vitals.csv",index=False)
    print("Synthetic files written; NOT real clinical observations")

def main():
    ap=argparse.ArgumentParser()
    ap.add_argument("action",choices=["synthetic","train"])
    ap.add_argument("--sessions",default="demo/sessions.csv")
    ap.add_argument("--vitals",default="demo/vitals.csv")
    ap.add_argument("--out",default="demo")
    args=ap.parse_args()
    if args.action=="synthetic":synthetic(args.out)
    else:train(args.sessions,args.vitals,args.out)
if __name__=="__main__":main()
