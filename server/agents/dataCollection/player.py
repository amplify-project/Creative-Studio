import sqlite3
import json
import time
import argparse
import numpy as np
import cv2

# ---------------- Config ----------------
CANVAS_SIZE = (720, 1280, 3)  # h, w, c
PLAY_FPS = 10.0
SKELETON_COLOR = (0, 255, 0)
GAZE_COLOR = (0, 0, 255)
HEAD_COLOR = (255, 0, 0)

POSE_CONNECTIONS = [
    (11, 13), (13, 15),  # left arm
    (12, 14), (14, 16),  # right arm
    (11, 12),            # shoulders
    (23, 24),            # hips
    (11, 23), (12, 24),  # torso
    (23, 25), (25, 27),  # left leg
    (24, 26), (26, 28),  # right leg
]

# ---------------- Utils ----------------
def draw_pose(canvas, landmarks):
    h, w = canvas.shape[:2]
    pts = []

    for lm in landmarks:
        x = int(lm["x"] * w)
        y = int(lm["y"] * h)
        pts.append((x, y))
        cv2.circle(canvas, (x, y), 3, SKELETON_COLOR, -1)

    for a, b in POSE_CONNECTIONS:
        if a < len(pts) and b < len(pts):
            cv2.line(canvas, pts[a], pts[b], SKELETON_COLOR, 2)

def draw_gaze(canvas, gaze_vec, head_xy=None):
    h, w = canvas.shape[:2]

    if head_xy:
        cx = int(head_xy["x"] * w)
        cy = int(head_xy["y"] * h)
    else:
        cx, cy = w // 2, h // 4  # fallback

    gv = np.array(gaze_vec)
    length = 120

    end = (
        int(cx + gv[0] * length),
        int(cy + gv[1] * length),
    )

    cv2.arrowedLine(canvas, (cx, cy), end, GAZE_COLOR, 3)
    cv2.circle(canvas, (cx, cy), 5, HEAD_COLOR, -1)

# ---------------- Main ----------------
def main(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # listar track_ids disponibles
    cursor.execute("SELECT DISTINCT track_id FROM pose_gaze")
    tracks = [row[0] for row in cursor.fetchall()]

    if not tracks:
        print("No tracks found in database")
        return

    print("Available tracks:")
    for i, t in enumerate(tracks):
        print(f"{i}: {t}")

    idx = int(input("Select track index to play: "))
    track_id = tracks[idx]
    print(f"Playing track: {track_id}")

    cursor.execute(
        "SELECT ts, pose_detected, face_detected, pose_landmarks, head_xy, gaze_vector "
        "FROM pose_gaze WHERE track_id = ? ORDER BY ts ASC",
        (track_id,)
    )
    rows = cursor.fetchall()
    if not rows:
        print("No data for this track")
        return

    delay = 1.0 / PLAY_FPS

    for ts, pose_detected, face_detected, pose_landmarks, head_xy, gaze_vector in rows:
        canvas = np.zeros(CANVAS_SIZE, dtype=np.uint8)

        if pose_detected and pose_landmarks:
            draw_pose(canvas, json.loads(pose_landmarks))

        if face_detected and gaze_vector:
            draw_gaze(canvas, json.loads(gaze_vector), head_xy=json.loads(head_xy) if head_xy else None)

        cv2.imshow("Pose + Gaze Player", canvas)
        if cv2.waitKey(1) & 0xFF == ord("q"):
            break

        time.sleep(delay)

    cv2.destroyAllWindows()
    conn.close()

# ---------------- Entry ----------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("db_file", help="Path to SQLite DB")
    args = parser.parse_args()

    main(args.db_file)
