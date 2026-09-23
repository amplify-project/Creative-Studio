import sqlite3
import json
import time
import argparse
import math
import numpy as np
import cv2

# ---------------- Config ----------------
CANVAS_H, CANVAS_W = 720, 1280
PLAY_FPS = 10.0

SKELETON_COLOR = (0, 255, 0)
GAZE_COLOR = (0, 0, 255)
HEAD_COLOR = (255, 0, 0)
LAYOUT_COLOR = (80, 80, 80)
HIGHLIGHT_COLOR = (0, 255, 255)
TEXT_COLOR = (255, 255, 255)

POSE_CONNECTIONS = [
    (11, 13), (13, 15),
    (12, 14), (14, 16),
    (11, 12),
    (23, 24),
    (11, 23), (12, 24),
    (23, 25), (25, 27),
    (24, 26), (26, 28),
]

# ---------------- Utils ----------------
def draw_pose(canvas, landmarks):
    h, w = canvas.shape[:2]
    pts = []
    for lm in landmarks:
        x, y = int(lm["x"]*w), int(lm["y"]*h)
        pts.append((x, y))
        cv2.circle(canvas, (x, y), 3, SKELETON_COLOR, -1)
    for a, b in POSE_CONNECTIONS:
        if a < len(pts) and b < len(pts):
            cv2.line(canvas, pts[a], pts[b], SKELETON_COLOR, 2)

def draw_gaze(canvas, gaze_vec, head_xy=None):
    h, w = canvas.shape[:2]
    cx, cy = (w//2, h//4) if head_xy is None else (int(head_xy["x"]*w), int(head_xy["y"]*h))
    gv = np.array(gaze_vec)
    length = 120
    end = (int(cx+gv[0]*length), int(cy+gv[1]*length))
    cv2.arrowedLine(canvas, (cx, cy), end, GAZE_COLOR, 3)
    cv2.circle(canvas, (cx, cy), 5, HEAD_COLOR, -1)

def project_gaze(gaze, head_xy):
    ox = head_xy.get("x", 0.5)
    oy = head_xy.get("y", 0.3)-0.08
    gx = ox - gaze[0]*0.6
    gy = oy - gaze[1]*0.35
    return max(0, min(1, gx)), max(0, min(1, gy))

def build_grid(entities):
    """Construye un grid proporcional con filas y columnas según elementos visibles"""
    visible = [e for e in entities.values() if e.get("visible", True)]
    n = len(visible)
    if n == 0: return []
    cols = math.ceil(math.sqrt(n))
    rows = math.ceil(n / cols)
    cells, idx = [], 0
    for r in range(rows):
        for c in range(cols):
            if idx >= n: break
            x0, y0 = c/cols, r/rows
            x1, y1 = (c+1)/cols, (r+1)/rows
            cells.append({"entity": visible[idx], "rect": (x0,y0,x1,y1)})
            idx += 1
    return cells

def draw_layout(canvas, cells, gaze_xy, layout_type="unknown"):
    h, w = canvas.shape[:2]
    gx, gy = gaze_xy
    gaze_px = (int(gx*w), int(gy*h))
    hit = None
    for cell in cells:
        x0,y0,x1,y1 = cell["rect"]
        px0, py0, px1, py1 = int(x0*w), int(y0*h), int(x1*w), int(y1*h)
        px1 = max(px1, px0+20)
        py1 = max(py1, py0+20)
        if x0 <= gx <= x1 and y0 <= gy <= y1: hit = (px0, py0, px1, py1)
        cv2.rectangle(canvas, (px0, py0), (px1, py1), LAYOUT_COLOR, 2)
        name = cell["entity"].get("name", "")
        if name:
            cv2.putText(canvas, name, (px0+3, py0+15),
                        cv2.FONT_HERSHEY_SIMPLEX, 0.5, TEXT_COLOR, 1)
    if hit:
        cv2.rectangle(canvas, (hit[0], hit[1]), (hit[2], hit[3]), HIGHLIGHT_COLOR, 3)
    cv2.circle(canvas, gaze_px, 6, GAZE_COLOR, -1)
    cv2.putText(canvas, f"Layout: {layout_type}", (10,30),
                cv2.FONT_HERSHEY_SIMPLEX, 1.0, TEXT_COLOR, 2)

# ---------------- Main ----------------
def main(db_path):
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    # listar tracks
    cursor.execute("SELECT DISTINCT track_id FROM pose_gaze")
    tracks = [row[0] for row in cursor.fetchall()]
    if not tracks: print("No tracks"); return
    print("Available tracks:")
    for i,t in enumerate(tracks): print(f"{i}: {t}")
    idx = int(input("Select track index: "))
    track_id = tracks[idx]
    print(f"Playing track {track_id}")

    # cargar poses
    cursor.execute(
        "SELECT ts, pose_detected, face_detected, pose_landmarks, head_xy, gaze_vector "
        "FROM pose_gaze WHERE track_id=? ORDER BY ts ASC", (track_id,)
    )
    poses = cursor.fetchall()

    # cargar layouts
    cursor.execute("SELECT ts_recv, entities, layout_type FROM layouts ORDER BY ts_recv ASC")
    layouts = [(ts, json.loads(entities), layout) for ts, entities, layout in cursor.fetchall()]

    layout_idx = 0
    delay = 1.0 / PLAY_FPS

    for ts, pose_detected, face_detected, pose_landmarks, head_xy, gaze_vector in poses:
        # sincronizar layout
        while layout_idx+1 < len(layouts) and layouts[layout_idx+1][0] <= ts:
            layout_idx += 1
        layout_ts, entities, layout_type = layouts[layout_idx]

        canvas = np.zeros((CANVAS_H, CANVAS_W, 3), dtype=np.uint8)
        gaze_xy = (0.5, 0.5)
        if face_detected and gaze_vector and head_xy:
            gaze_xy = project_gaze(json.loads(gaze_vector), json.loads(head_xy))

        cells = build_grid(entities) if layout_type=="grid" else []
        draw_layout(canvas, cells, gaze_xy, layout_type=layout_type)

        if pose_detected and pose_landmarks:
            draw_pose(canvas, json.loads(pose_landmarks))

        cv2.imshow("Pose + Gaze + Layout", canvas)
        if cv2.waitKey(1) & 0xFF == ord("q"): break
        time.sleep(delay)

    conn.close()
    cv2.destroyAllWindows()

# ---------------- Entry ----------------
if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("db_file", help="SQLite DB path")
    args = parser.parse_args()
    main(args.db_file)
