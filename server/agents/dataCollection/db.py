# db.py
import os
import sqlite3
import threading
import json
import time
from typing import Dict, Any
class DB:
    def __init__(self, room_dir: str):
        os.makedirs(room_dir, exist_ok=True)
        self.path = os.path.join(room_dir, "data.db")
        self.conn = sqlite3.connect(self.path, check_same_thread=False)
        self.lock = threading.Lock()
        self._init_tables()

    def _init_tables(self):
        with self.lock, self.conn:
            self.conn.execute("""
            CREATE TABLE IF NOT EXISTS pose_gaze (
                ts REAL,
                track_id TEXT,
                pose_detected INTEGER,
                face_detected INTEGER,
                pose_landmarks TEXT,
                head_xy TEXT,
                gaze_vector TEXT
            )
            """)
            self.conn.execute("""
                CREATE TABLE IF NOT EXISTS layouts (
                    ts_recv REAL PRIMARY KEY,
                    layout_type TEXT,
                    entities TEXT,
                    visibility TEXT
                )
            """)
            self.conn.execute("""
                CREATE TABLE IF NOT EXISTS audio_clips (
                    ts_start REAL,
                    ts_end REAL,
                    track_id TEXT,
                    duration REAL,
                    peak_rms REAL,
                    frames INTEGER
                )
            """)
            self.conn.execute("""
                CREATE TABLE IF NOT EXISTS audio_analysis (
                    ts REAL,
                    track_id TEXT,
                    voice_probability REAL,
                    voice_detected INTEGER,
                    music_probability REAL,
                    music_active INTEGER,
                    processing_mode INTEGER,
                    degradation_detected INTEGER,
                    distortion_type INTEGER,
                    distortion_name TEXT,
                    probabilities TEXT
                )
            """)
            self._migrate_audio_analysis_schema()
            self.conn.commit()

    def _migrate_audio_analysis_schema(self):
        cursor = self.conn.execute("PRAGMA table_info(audio_analysis)")
        existing_columns = {row[1] for row in cursor.fetchall()}

        if "music_probability" not in existing_columns:
            self.conn.execute("ALTER TABLE audio_analysis ADD COLUMN music_probability REAL")
        if "music_active" not in existing_columns:
            self.conn.execute("ALTER TABLE audio_analysis ADD COLUMN music_active INTEGER")
        if "processing_mode" not in existing_columns:
            self.conn.execute("ALTER TABLE audio_analysis ADD COLUMN processing_mode INTEGER")

    # ---- buffered insert for pose_gaze ----
    def store_pose(self, record: dict):
        with self.lock, self.conn:
            self.conn.execute("""
            INSERT INTO pose_gaze VALUES (?, ?, ?, ?, ?, ?, ?)
            """, (
                record["ts"],
                record["track_id"],
                int(record.get("pose_detected", 0)),
                int(record.get("face_detected", 0)),
                json.dumps(record.get("pose_landmarks")),
                json.dumps(record.get("head_xy")),
                json.dumps(record.get("gaze_vector")),
            ))



    def store_layout(self, snapshot: Dict[str, Any]):
        self.conn.execute("""
            INSERT OR REPLACE INTO layouts (
                ts_recv, visibility, layout_type, entities 
            ) VALUES (?, ?, ?, ?)
        """, (
            snapshot.get("ts_recv"),
            json.dumps(snapshot.get("visibility", {})),
            snapshot.get("layout", "grid"),
            json.dumps(snapshot.get("entities", {})),
        ))
        self.conn.commit()

    def store_audio_clip(self, clip: Dict[str, Any]):
        with self.lock, self.conn:
            self.conn.execute("""
                INSERT INTO audio_clips VALUES (?, ?, ?, ?, ?, ?)
            """, (
                clip.get("ts_start"),
                clip.get("ts_end"),
                clip.get("track_id"),
                clip.get("duration"),
                clip.get("peak_rms"),
                int(clip.get("frames", 0)),
            ))

    def store_audio_analysis(self, record: Dict[str, Any]):
        with self.lock, self.conn:
            self.conn.execute("""
                INSERT INTO audio_analysis (
                    ts,
                    track_id,
                    voice_probability,
                    voice_detected,
                    music_probability,
                    music_active,
                    processing_mode,
                    degradation_detected,
                    distortion_type,
                    distortion_name,
                    probabilities
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, (
                record.get("ts"),
                record.get("track_id"),
                float(record.get("voice_probability", 0.0)),
                int(record.get("voice_detected", 0)),
                float(record.get("music_probability", 0.0)),
                int(record.get("music_active", 0)),
                int(record.get("processing_mode", 0)),
                int(record.get("degradation_detected", 0)),
                record.get("distortion_type"),
                record.get("distortion_name"),
                json.dumps(record.get("probabilities", [])),
            ))

    def close(self):
        with self.lock:
            self.conn.commit()
            self.conn.close()
