"""Basic time-series leakage and patient/session separation tests.
Run: python -m unittest discover -s ml -p 'test_*.py'
"""
import unittest
import pandas as pd
from train import make_features

class FeatureTests(unittest.TestCase):
    def test_future_event_not_used_as_present_feature(self):
        start = pd.Timestamp("2026-01-01 08:00")
        rows = []
        for i, sbp in enumerate([150, 125, 85, 110, 115]):
            rows.append(dict(session_id="S1", patient_id="P1",
                session_start=start, session_end=start+pd.Timedelta(hours=4),
                session_type="routine", measured_at=start+pd.Timedelta(hours=i),
                sbp=sbp, dbp=60, hr=80, pre_sbp=150, ufr_kg_h=10,
                idh_prev10_routine=0, idh_prev10_all=0,
                can_status="unknown", dm=0))
        out = make_features(pd.DataFrame(rows))
        self.assertEqual(out.idh_next_60min.tolist(), [0,1])
        self.assertEqual(out.sbp.tolist(), [150,125])
        self.assertEqual(out.session_id.nunique(), 1)
        self.assertTrue((out.prediction_at < start+pd.Timedelta(hours=2)).all())

    def test_never_cross_sessions(self):
        start = pd.Timestamp("2026-01-01 08:00")
        def row(sid, i, bp):
            return dict(session_id=sid,patient_id="P1",
                session_start=start,session_end=start+pd.Timedelta(hours=2),
                session_type="routine",measured_at=start+pd.Timedelta(hours=i),
                sbp=bp,dbp=60,hr=80,pre_sbp=140,ufr_kg_h=9,
                idh_prev10_routine=0,idh_prev10_all=0,can_status="unknown",dm=0)
        a = make_features(pd.DataFrame([
            row("S1",0,130),row("S1",1,89),row("S1",2,110),
            row("S2",0,140),row("S2",1,130),row("S2",2,120),
        ]))
        self.assertEqual(a.set_index("session_id").loc["S1","idh_next_60min"],1)
        self.assertEqual(a.set_index("session_id").loc["S2","idh_next_60min"].tolist(),[0,0])

if __name__=="__main__":
    unittest.main()
